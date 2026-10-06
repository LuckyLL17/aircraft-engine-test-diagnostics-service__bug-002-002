import { invariant } from '../errors.ts';
import type { CalibratedSample, EnginePhaseName, PhaseSegment } from '../types.ts';

const IDLE_RPM_THRESHOLD = 500;
const SLOPE_THRESHOLD_RPM_PER_SECOND = 0.25;

type RpmPoint = { time: number; rpm: number };
type FuelPoint = { time: number; fuel: number };

type WorkingSegment = {
  phase: EnginePhaseName;
  startMs: number;
  endMs: number;
  sampleCount: number;
  rpmSum: number;
  peakRpm: number;
  fuelSum: number;
  fuelSampleCount: number;
};

function collectSamples(samples: CalibratedSample[]): { rpmPoints: RpmPoint[]; fuelPoints: FuelPoint[] } {
  const rpmPoints: RpmPoint[] = [];
  const fuelPoints: FuelPoint[] = [];
  for (const sample of samples) {
    if (!Number.isFinite(sample.calibratedValue)) continue;
    if (sample.sensor === 'rpm') rpmPoints.push({ time: sample.sampleTimeMs, rpm: sample.calibratedValue });
    if (sample.sensor === 'fuel-flow') fuelPoints.push({ time: sample.sampleTimeMs, fuel: sample.calibratedValue });
  }
  const byTime = (a: { time: number }, b: { time: number }) => a.time - b.time;
  rpmPoints.sort(byTime);
  fuelPoints.sort(byTime);
  return { rpmPoints, fuelPoints };
}

function classifyPhases(points: RpmPoint[]): EnginePhaseName[] {
  const phases: EnginePhaseName[] = [];
  let hasLeftIdle = false;

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    let slopeRpmPerSecond = 0;
    if (i > 0) {
      const elapsedMs = point.time - points[i - 1].time;
      if (elapsedMs > 0) slopeRpmPerSecond = (point.rpm - points[i - 1].rpm) / elapsedMs * 1000;
    }

    let phase: EnginePhaseName;
    if (point.rpm <= IDLE_RPM_THRESHOLD) {
      phase = hasLeftIdle ? 'shutdown' : 'idle';
    } else if (slopeRpmPerSecond >= SLOPE_THRESHOLD_RPM_PER_SECOND) {
      phase = 'acceleration';
    } else if (slopeRpmPerSecond <= -SLOPE_THRESHOLD_RPM_PER_SECOND) {
      phase = 'deceleration';
    } else {
      phase = 'steady';
    }

    phases.push(phase);
    hasLeftIdle ||= point.rpm > IDLE_RPM_THRESHOLD;
  }

  return phases;
}

function createSegment(phase: EnginePhaseName, point: RpmPoint): WorkingSegment {
  return {
    phase,
    startMs: point.time,
    endMs: point.time,
    sampleCount: 1,
    rpmSum: point.rpm,
    peakRpm: point.rpm,
    fuelSum: 0,
    fuelSampleCount: 0,
  };
}

function addRpmPoint(segment: WorkingSegment, point: RpmPoint): void {
  segment.sampleCount += 1;
  segment.rpmSum += point.rpm;
  segment.peakRpm = Math.max(segment.peakRpm, point.rpm);
  segment.endMs = point.time;
}

function buildRawSegments(points: RpmPoint[], phases: EnginePhaseName[]): WorkingSegment[] {
  const segments: WorkingSegment[] = [];
  for (const [index, point] of points.entries()) {
    const phase = phases[index];
    const previous = segments.at(-1);
    if (previous && previous.phase === phase) addRpmPoint(previous, point);
    else segments.push(createSegment(phase, point));
  }

  // A transition is detected at its first sample of the new phase.  The preceding
  // phase ends at that same boundary, so irregular gaps remain covered exactly once.
  for (let i = 0; i < segments.length - 1; i += 1) segments[i].endMs = segments[i + 1].startMs;
  return segments;
}

function segmentIndexAtTime(segments: WorkingSegment[], time: number): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (segments[middle].startMs <= time) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function assignFuelSamples(segments: WorkingSegment[], fuelPoints: FuelPoint[]): void {
  if (segments.length === 0) return;
  for (const point of fuelPoints) {
    const segment = segments[segmentIndexAtTime(segments, point.time)];
    segment.fuelSum += point.fuel;
    segment.fuelSampleCount += 1;
  }
}

function durationOf(segment: WorkingSegment): number {
  return segment.endMs - segment.startMs;
}

function mergeSegments(left: WorkingSegment, right: WorkingSegment, phase: EnginePhaseName): WorkingSegment {
  return {
    phase,
    startMs: left.startMs,
    endMs: right.endMs,
    sampleCount: left.sampleCount + right.sampleCount,
    rpmSum: left.rpmSum + right.rpmSum,
    peakRpm: Math.max(left.peakRpm, right.peakRpm),
    fuelSum: left.fuelSum + right.fuelSum,
    fuelSampleCount: left.fuelSampleCount + right.fuelSampleCount,
  };
}

function isDominant(left: WorkingSegment, right: WorkingSegment): boolean {
  return durationOf(left) > durationOf(right)
    || (durationOf(left) === durationOf(right) && left.sampleCount >= right.sampleCount);
}

function mergeShortSegments(segments: WorkingSegment[], minimumDurationMs: number): WorkingSegment[] {
  const result = [...segments];

  while (true) {
    const index = result.findIndex((segment) => durationOf(segment) < minimumDurationMs);
    if (index === -1 || result.length === 1) return result;

    if (index === 0) {
      result.splice(0, 2, mergeSegments(result[0], result[1], result[1].phase));
      continue;
    }

    const left = result[index - 1];
    const short = result[index];
    const right = result[index + 1];

    if (!right) {
      result.splice(index - 1, 2, mergeSegments(left, short, left.phase));
    } else if (left.phase === right.phase) {
      const merged = mergeSegments(mergeSegments(left, short, left.phase), right, left.phase);
      result.splice(index - 1, 3, merged);
    } else if (left.phase === short.phase && right.phase !== short.phase) {
      result.splice(index - 1, 2, mergeSegments(left, short, left.phase));
    } else if (right.phase === short.phase && left.phase !== short.phase) {
      result.splice(index, 2, mergeSegments(short, right, right.phase));
    } else if (isDominant(left, right)) {
      result.splice(index - 1, 2, mergeSegments(left, short, left.phase));
    } else {
      result.splice(index, 2, mergeSegments(short, right, right.phase));
    }
  }
}

function toPhaseSegment(segment: WorkingSegment): PhaseSegment {
  return {
    phase: segment.phase,
    startMs: segment.startMs,
    endMs: segment.endMs,
    sampleCount: segment.sampleCount,
    meanRpm: segment.rpmSum / segment.sampleCount,
    peakRpm: segment.peakRpm,
    meanFuelFlow: segment.fuelSampleCount ? segment.fuelSum / segment.fuelSampleCount : 0,
  };
}

export function segmentOperatingPhases(samples: CalibratedSample[], minimumPhaseDurationMs = 500): PhaseSegment[] {
  const { rpmPoints, fuelPoints } = collectSamples(samples);
  invariant(rpmPoints.length > 0, 'RPM_DATA_MISSING', 'At least one calibrated RPM sample is required');

  const phases = classifyPhases(rpmPoints);
  const segments = buildRawSegments(rpmPoints, phases);
  assignFuelSamples(segments, fuelPoints);

  return mergeShortSegments(segments, minimumPhaseDurationMs).map(toPhaseSegment);
}
