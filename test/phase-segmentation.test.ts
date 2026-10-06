import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentOperatingPhases } from '../src/domain/phase/segment.ts';
import type { CalibratedSample } from '../src/domain/types.ts';

let sequence = 0;

function sample(sampleTimeMs: number, sensor: 'rpm' | 'fuel-flow', value: number): CalibratedSample {
  sequence += 1;
  return {
    runId: 'run-1',
    eventId: `event-${sequence}`,
    sampleTimeMs,
    receivedTimeMs: sampleTimeMs,
    sequence,
    sensor,
    value,
    unit: sensor === 'rpm' ? 'rpm' : 'kg/s',
    calibratedValue: value,
    uncertainty: 0,
    calibrationVersion: 'v1',
  } as CalibratedSample;
}

function runOf(points: Array<[number, number, number?]>): CalibratedSample[] {
  const samples: CalibratedSample[] = [];
  for (const [time, rpm, fuel] of points) {
    samples.push(sample(time, 'rpm', rpm));
    if (fuel !== undefined) samples.push(sample(time, 'fuel-flow', fuel));
  }
  return samples;
}

function assertContinuous(segments: ReturnType<typeof segmentOperatingPhases>, firstMs: number, lastMs: number, totalSamples: number) {
  assert.equal(segments[0].startMs, firstMs);
  assert.equal(segments.at(-1)!.endMs, lastMs);
  for (let index = 1; index < segments.length; index += 1) assert.equal(segments[index - 1].endMs, segments[index].startMs);
  assert.equal(segments.reduce((sum, segment) => sum + segment.sampleCount, 0), totalSamples);
}

test('full ground run segments into shutdown, acceleration, steady, deceleration, shutdown under non-uniform sampling', () => {
  const points: Array<[number, number]> = [
    [0, 0], [150, 0], [400, 0], [700, 0], [1000, 0],
    [1100, 300], [1300, 700], [1600, 1200], [1900, 1800], [2300, 2600], [2600, 3200],
    [2900, 3200], [3200, 3200], [3500, 3200], [3800, 3200],
    [3900, 2400], [4100, 1600], [4400, 1000], [4700, 600], [4800, 100], [5000, 0],
    [5100, 0], [5400, 0], [5700, 0], [6000, 0],
  ];
  const segments = segmentOperatingPhases(runOf(points));
  assert.deepEqual(segments.map((segment) => segment.phase), ['shutdown', 'acceleration', 'steady', 'deceleration', 'shutdown']);
  assert.deepEqual(segments.map((segment) => segment.sampleCount), [5, 6, 4, 6, 4]);
  assert.deepEqual(segments.map((segment) => segment.startMs), [0, 1050, 2750, 3850, 5050]);
  assert.deepEqual(segments.map((segment) => segment.endMs), [1050, 2750, 3850, 5050, 6000]);
  assertContinuous(segments, 0, 6000, 25);
  assert.ok(Math.abs(segments[1].meanRpm - 9800 / 6) < 1e-9);
  assert.equal(segments[2].meanRpm, 3200);
  assert.equal(segments[2].peakRpm, 3200);
  assert.equal(segments[2].meanFuelFlow, 0);
  assert.deepEqual(segmentOperatingPhases(runOf(points).reverse()), segments);
});

test('slope uses the real adjacent interval and exact threshold hits are transients', () => {
  const segments = segmentOperatingPhases(runOf([
    [0, 5000], [1000, 5000],
    [5000, 5001],
    [9000, 5000],
    [9000.5, 5000.0002],
  ]), 0);
  assert.deepEqual(segments.map((segment) => segment.phase), ['steady', 'acceleration', 'deceleration', 'acceleration']);
  assert.deepEqual(segments.map((segment) => segment.sampleCount), [2, 1, 1, 1]);
  assertContinuous(segments, 0, 9000.5, 5);
});

test('short-lived jitter is absorbed and never splits or reattributes samples', () => {
  const points: Array<[number, number]> = [];
  for (let time = 0; time <= 2000; time += 100) points.push([time, 6000]);
  points[10] = [1000, 6400];
  points[11] = [1100, 6500];
  const segments = segmentOperatingPhases(runOf(points));
  assert.equal(segments.length, 1);
  assert.equal(segments[0].phase, 'steady');
  assert.equal(segments[0].sampleCount, 21);
  assert.equal(segments[0].peakRpm, 6500);
  assert.ok(Math.abs(segments[0].meanRpm - 126900 / 21) < 1e-9);
  assertContinuous(segments, 0, 2000, 21);
});

test('a sampling gap is a hard boundary and never counts towards phase persistence', () => {
  const stable = segmentOperatingPhases(runOf([
    [0, 8000], [1000, 8000], [2000, 8000],
    [32000, 8000], [33000, 8000], [34000, 8000],
  ]));
  assert.equal(stable.length, 1);
  assert.equal(stable[0].phase, 'steady');
  assertContinuous(stable, 0, 34000, 6);

  const changed = segmentOperatingPhases(runOf([
    [0, 9000], [1000, 9000], [2000, 9000],
    [22000, 3000], [23000, 3000], [24000, 3000],
  ]));
  assert.deepEqual(changed.map((segment) => segment.phase), ['steady', 'deceleration', 'steady']);
  assert.deepEqual(changed.map((segment) => segment.sampleCount), [3, 1, 2]);
  assert.equal(changed[0].endMs, 12000);
  assert.equal(changed[1].endMs, 22500);
  assertContinuous(changed, 0, 24000, 6);
});

test('merged segments keep exact fuel statistics over fuel-valid samples only', () => {
  const segments = segmentOperatingPhases(runOf([
    [0, 5000, 1], [100, 5100], [200, 5100, 2], [300, 5100, 2],
    [400, 5100], [500, 5100, 2], [600, 5100, 2], [700, 5100, 2],
  ]));
  assert.equal(segments.length, 1);
  assert.equal(segments[0].phase, 'steady');
  assert.equal(segments[0].sampleCount, 8);
  assert.equal(segments[0].meanRpm, 40700 / 8);
  assert.ok(Math.abs(segments[0].meanFuelFlow - 11 / 6) < 1e-9);
  assertContinuous(segments, 0, 700, 8);
});

test('startup and shutdown boundaries follow the slope below 500 rpm', () => {
  const segments = segmentOperatingPhases(runOf([
    [0, 0], [200, 0], [400, 0], [600, 0],
    [700, 200], [800, 500], [900, 900], [1000, 1400], [1100, 2000], [1200, 2700],
    [1300, 1400], [1400, 900], [1500, 500], [1600, 200], [1700, 50], [1800, 0],
    [1900, 0], [2000, 0], [2100, 0], [2200, 0], [2300, 0], [2400, 0],
  ]));
  assert.deepEqual(segments.map((segment) => segment.phase), ['shutdown', 'acceleration', 'deceleration', 'shutdown']);
  assert.equal(segments[1].startMs, 650);
  assert.equal(segments[1].sampleCount, 6);
  assert.equal(segments[2].endMs, 1850);
  assert.equal(segments[2].sampleCount, 6);
  assertContinuous(segments, 0, 2400, 22);
});

test('a candidate phase lasting exactly the minimum duration is confirmed and kept', () => {
  const segments = segmentOperatingPhases(runOf([
    [0, 5000], [500, 5000], [1000, 5000],
    [1250, 5100], [1500, 5200], [1750, 5300],
    [2000, 5300], [2500, 5300], [3000, 5300],
  ]), 500);
  assert.deepEqual(segments.map((segment) => segment.phase), ['steady', 'acceleration', 'steady']);
  assert.equal(segments[1].sampleCount, 3);
  assertContinuous(segments, 0, 3000, 9);
});

test('degenerate inputs are rejected or produce a single segment', () => {
  assert.throws(() => segmentOperatingPhases([]), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'RPM_DATA_MISSING');
  assert.throws(() => segmentOperatingPhases(runOf([[0, 0]]).map((entry) => ({ ...entry, sensor: 'fuel-flow' as const }))), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'RPM_DATA_MISSING');
  const [stopped] = segmentOperatingPhases(runOf([[5000, 0]]));
  assert.equal(stopped.phase, 'shutdown');
  assert.equal(stopped.startMs, 5000);
  assert.equal(stopped.endMs, 5000);
  assert.equal(stopped.sampleCount, 1);
  const [running] = segmentOperatingPhases(runOf([[5000, 5000]]));
  assert.equal(running.phase, 'steady');
});
