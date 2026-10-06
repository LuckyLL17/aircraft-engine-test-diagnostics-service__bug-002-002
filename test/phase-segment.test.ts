import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentOperatingPhases } from '../src/domain/phase/segment.ts';
import type { CalibratedSample, SensorKind } from '../src/domain/types.ts';

function sample(id: string, sampleTimeMs: number, sensor: SensorKind, calibratedValue: number): CalibratedSample {
  return {
    runId: 'run-1',
    eventId: id,
    sampleTimeMs,
    receivedTimeMs: sampleTimeMs + 10,
    sequence: Number(id.replace(/\D/g, '')),
    sensor,
    value: calibratedValue,
    unit: sensor === 'rpm' ? 'rpm' : 'kg/s',
    calibratedValue,
    uncertainty: 0,
    calibrationVersion: 'v1',
  };
}

function measuredPairs(pairs: Array<[number, number]>, sensor: SensorKind): CalibratedSample[] {
  return pairs.map(([time, value], index) => sample(`${sensor}-${index}`, time, sensor, value));
}

function rpmPairs(pairs: Array<[number, number]>): CalibratedSample[] {
  return measuredPairs(pairs, 'rpm');
}

function fuelPairs(pairs: Array<[number, number]>): CalibratedSample[] {
  return measuredPairs(pairs, 'fuel-flow');
}

test('segments a complete unevenly sampled run with inclusive thresholds and no overlaps', () => {
  const rpm = rpmPairs([
    [0, 0],
    [500, 500],
    [1500, 750],
    [2500, 1000],
    [3500, 1000],
    [4500, 750],
    [5500, 500],
    [6000, 250],
  ]);
  const fuel = fuelPairs([
    [0, 1],
    [500, 1.2],
    [1000, 0.8],
    [1500, 2],
    [2500, 2.25],
    [3000, 2.5],    [3500, 3],
    [4000, 3],
    [4500, 4],
    [5500, 5],
    [6000, 5],
  ]);

  const segments = segmentOperatingPhases([...rpm, ...fuel]);

  assert.deepEqual(segments.map((segment) => segment.phase), ['idle', 'acceleration', 'steady', 'deceleration', 'shutdown']);
  assert.deepEqual(segments.map((segment) => [segment.startMs, segment.endMs]), [[0, 1500], [1500, 3500], [3500, 4500], [4500, 5500], [5500, 6000]]);
  assert.deepEqual(segments.map((segment) => segment.sampleCount), [2, 2, 1, 1, 2]);
  assert.deepEqual(segments.map((segment) => segment.meanRpm), [250, 875, 1000, 750, 375]);
  assert.deepEqual(segments.map((segment) => segment.peakRpm), [500, 1000, 1000, 750, 500]);
  assert.deepEqual(segments.map((segment) => segment.meanFuelFlow), [1, 2.25, 3, 4, 5]);
  assert.equal(segments.reduce((total, segment) => total + segment.sampleCount, 0), rpm.length);
  assert.ok(segments.every((segment, index) => index === segments.length - 1 || segment.endMs === segments[index + 1].startMs));
});

test('merges short jitter into the surrounding phase while retaining every sample and fuel reading', () => {
  const rpm = rpmPairs([
    [0, 1000],
    [600, 1000],
    [1000, 1100],
    [1100, 1090],
    [1500, 1090],
    [2100, 1090],
  ]);
  const fuel = fuelPairs([
    [1050, 5],
    [1150, 7],
  ]);

  const segments = segmentOperatingPhases([...rpm, ...fuel]);

  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0], {
    phase: 'steady',
    startMs: 0,
    endMs: 2100,
    sampleCount: 6,
    meanRpm: 6370 / 6,
    peakRpm: 1100,
    meanFuelFlow: 6,
  });
});

test('preserves a phase whose elapsed duration is exactly the minimum', () => {
  const rpm = rpmPairs([
    [0, 0],
    [600, 0],
    [1000, 1000],
    [2000, 750],
    [2500, 500],
    [3000, 0],
  ]);

  const segments = segmentOperatingPhases(rpm, 500);

  assert.deepEqual(segments.map((segment) => segment.phase), ['idle', 'acceleration', 'deceleration', 'shutdown']);
  assert.deepEqual(segments.map((segment) => [segment.startMs, segment.endMs]), [[0, 1000], [1000, 2000], [2000, 2500], [2500, 3000]]);
});
