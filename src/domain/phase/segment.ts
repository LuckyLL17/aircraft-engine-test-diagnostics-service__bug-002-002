import { invariant } from '../errors.ts';
import type { CalibratedSample, EnginePhaseName, PhaseSegment } from '../types.ts';

type RpmPoint = { time: number; rpm: number; fuel: number };
type PhaseRun = { phase: EnginePhaseName; points: RpmPoint[] };
type DraftSegment = PhaseRun & { startMs: number; endMs: number };

const PHASE_SLOPE_THRESHOLD_RPM_PER_SECOND = 0.25;
const SHUTDOWN_MAX_RPM = 500;
const DEFAULT_MAX_SAMPLING_GAP_MS = 10_000;

function collectPoints(samples: CalibratedSample[]): RpmPoint[] {
  const byTime = new Map<number, RpmPoint>();
  for (const sample of samples) {
    const point = byTime.get(sample.sampleTimeMs) ?? { time: sample.sampleTimeMs, rpm: Number.NaN, fuel: Number.NaN };
    if (sample.sensor === 'rpm') point.rpm = sample.calibratedValue;
    if (sample.sensor === 'fuel-flow') point.fuel = sample.calibratedValue;
    byTime.set(sample.sampleTimeMs, point);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time).filter((point) => Number.isFinite(point.rpm));
}

// Slope wins over the rpm band so spool-up below 500 rpm is acceleration, not
// shutdown; an exact threshold hit counts as a transient.
function phaseForSlope(slopeRpmPerSecond: number, rpm: number): EnginePhaseName {
  if (slopeRpmPerSecond >= PHASE_SLOPE_THRESHOLD_RPM_PER_SECOND) return 'acceleration';
  if (slopeRpmPerSecond <= -PHASE_SLOPE_THRESHOLD_RPM_PER_SECOND) return 'deceleration';
  if (rpm <= SHUTDOWN_MAX_RPM) return 'shutdown';
  return 'steady';
}

// Every interval uses the real elapsed time between its two samples; the
// sampling period is never clamped or assumed.
function intervalSlopes(points: RpmPoint[]): number[] {
  const slopes = [Number.NaN];
  for (let index = 1; index < points.length; index += 1) {
    const elapsedMs = points[index].time - points[index - 1].time;
    invariant(elapsedMs > 0, 'RPM_TIMELINE_DISORDERED', 'RPM sample times must be strictly increasing', { sampleTimeMs: points[index].time });
    slopes.push(((points[index].rpm - points[index - 1].rpm) / elapsedMs) * 1000);
  }
  return slopes;
}

function labelPoints(points: RpmPoint[]): EnginePhaseName[] {
  const slopes = intervalSlopes(points);
  return points.map((point, index) => {
    const slope = index === 0 ? slopes[1] ?? 0 : slopes[index];
    return phaseForSlope(slope, point.rpm);
  });
}

// A candidate phase must persist for the minimum duration, measured on real
// sample timestamps, before it replaces the current segment; shorter
// deviations are jitter and stay in the current segment. A zero minimum
// confirms every label change immediately. A sampling gap is a hard
// boundary: its duration never counts towards phase persistence.
function splitIntoRuns(points: RpmPoint[], labels: EnginePhaseName[], minimumPhaseDurationMs: number, maxSamplingGapMs: number): PhaseRun[] {
  const runs: PhaseRun[] = [];
  let current: PhaseRun = { phase: labels[0], points: [points[0]] };
  let pending: PhaseRun | null = null;
  const absorbPending = () => {
    if (pending) {
      current.points.push(...pending.points);
      pending = null;
    }
  };
  const confirmPendingIfPersisted = () => {
    if (pending && pending.points.at(-1)!.time - pending.points[0].time >= minimumPhaseDurationMs) {
      runs.push(current);
      current = { phase: pending.phase, points: pending.points };
      pending = null;
    }
  };
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point.time - points[index - 1].time > maxSamplingGapMs) {
      absorbPending();
      runs.push(current);
      current = { phase: labels[index], points: [point] };
      continue;
    }
    if (pending && labels[index] === pending.phase) {
      pending.points.push(point);
      confirmPendingIfPersisted();
      continue;
    }
    absorbPending();
    if (labels[index] === current.phase) current.points.push(point);
    else {
      pending = { phase: labels[index], points: [point] };
      confirmPendingIfPersisted();
    }
  }
  absorbPending();
  runs.push(current);
  return runs;
}

// Boundaries sit halfway between the last sample of one run and the first
// sample of the next, so segments tile the whole run with no gaps, no
// overlaps and no shared samples.
function tileBoundaries(runs: PhaseRun[], points: RpmPoint[]): DraftSegment[] {
  return runs.map((run, index) => {
    const startMs = index === 0 ? points[0].time : midpoint(runs[index - 1].points.at(-1)!.time, run.points[0].time);
    const endMs = index === runs.length - 1 ? points.at(-1)!.time : midpoint(run.points.at(-1)!.time, runs[index + 1].points[0].time);
    return { ...run, startMs, endMs };
  });
}

function midpoint(left: number, right: number): number {
  return left + (right - left) / 2;
}

function span(segment: DraftSegment): number {
  return segment.endMs - segment.startMs;
}

function join(phase: EnginePhaseName, ...segments: DraftSegment[]): DraftSegment {
  return { phase, points: segments.flatMap((segment) => segment.points), startMs: segments[0].startMs, endMs: segments.at(-1)!.endMs };
}

// A segment lasting exactly the minimum duration is valid and kept; only
// strictly shorter ones merge, preferring a same-phase neighbour and
// otherwise the longer neighbour.
function mergeShortSegments(segments: DraftSegment[], minimumPhaseDurationMs: number): DraftSegment[] {
  const result = [...segments];
  let changed = true;
  while (changed && result.length > 1) {
    changed = false;
    for (let index = 0; index < result.length; index += 1) {
      const segment = result[index];
      if (span(segment) >= minimumPhaseDurationMs) continue;
      const left = result[index - 1];
      const right = result[index + 1];
      if (left && right && left.phase === right.phase) result.splice(index - 1, 3, join(left.phase, left, segment, right));
      else if (left && left.phase === segment.phase) result.splice(index - 1, 2, join(left.phase, left, segment));
      else if (right && right.phase === segment.phase) result.splice(index, 2, join(right.phase, segment, right));
      else if (left && (!right || span(left) >= span(right))) result.splice(index - 1, 2, join(left.phase, left, segment));
      else if (right) result.splice(index, 2, join(right.phase, segment, right));
      changed = true;
      break;
    }
  }
  return result;
}

function coalesceSamePhase(segments: DraftSegment[]): DraftSegment[] {
  const result: DraftSegment[] = [];
  for (const segment of segments) {
    const previous = result.at(-1);
    if (previous && previous.phase === segment.phase) result[result.length - 1] = join(previous.phase, previous, segment);
    else result.push(segment);
  }
  return result;
}

function mergeUntilStable(segments: DraftSegment[], minimumPhaseDurationMs: number): DraftSegment[] {
  let current = segments;
  for (;;) {
    const next = coalesceSamePhase(mergeShortSegments(current, minimumPhaseDurationMs));
    if (next.length === current.length) return next;
    current = next;
  }
}

function toSegment(draft: DraftSegment): PhaseSegment {
  const fuels = draft.points.map((point) => point.fuel).filter(Number.isFinite);
  const rpms = draft.points.map((point) => point.rpm);
  return {
    phase: draft.phase,
    startMs: draft.startMs,
    endMs: draft.endMs,
    sampleCount: draft.points.length,
    meanRpm: rpms.reduce((a, b) => a + b, 0) / rpms.length,
    peakRpm: Math.max(...rpms),
    meanFuelFlow: fuels.length ? fuels.reduce((a, b) => a + b, 0) / fuels.length : 0,
  };
}

function assertConsistent(segments: PhaseSegment[], points: RpmPoint[]): void {
  invariant(segments[0].startMs === points[0].time && segments.at(-1)!.endMs === points.at(-1)!.time, 'PHASE_TIMELINE_DISCONTINUOUS', 'Phase segments must cover the whole run exactly once');
  const counted = segments.reduce((sum, segment) => sum + segment.sampleCount, 0);
  invariant(counted === points.length, 'PHASE_SAMPLE_COUNT_MISMATCH', 'Every RPM sample must belong to exactly one phase segment', { counted, expected: points.length });
  for (let index = 1; index < segments.length; index += 1) {
    invariant(segments[index - 1].endMs === segments[index].startMs, 'PHASE_TIMELINE_DISCONTINUOUS', 'Adjacent phase segments must share one boundary instant', { index });
  }
}

export function segmentOperatingPhases(samples: CalibratedSample[], minimumPhaseDurationMs = 500, maxSamplingGapMs = DEFAULT_MAX_SAMPLING_GAP_MS): PhaseSegment[] {
  invariant(Number.isFinite(minimumPhaseDurationMs) && minimumPhaseDurationMs >= 0, 'INVALID_PHASE_PARAMETERS', 'Minimum phase duration must be a non-negative finite number');
  invariant(Number.isFinite(maxSamplingGapMs) && maxSamplingGapMs > 0, 'INVALID_PHASE_PARAMETERS', 'Maximum sampling gap must be a positive finite number');
  const points = collectPoints(samples);
  invariant(points.length > 0, 'RPM_DATA_MISSING', 'At least one calibrated RPM sample is required');
  const runs = splitIntoRuns(points, labelPoints(points), minimumPhaseDurationMs, maxSamplingGapMs);
  const segments = mergeUntilStable(tileBoundaries(runs, points), minimumPhaseDurationMs).map(toSegment);
  assertConsistent(segments, points);
  return segments;
}
