import { describe, expect, it } from 'vitest';
import { NUMERIC_MEASUREMENTS, VIBRATION_ALERT_THRESHOLD_MM_S } from '@etp/shared';
import { FaultEngine, FaultSpec } from './faults.js';
import { IDLE_LOAD, isInWindow, LoadModel } from './load.js';
import { hashSeed, Rng } from './random.js';
import { clamp, round2, SignalModel } from './signals.js';
import { deriveStatus } from './status.js';

const MIN = 60_000;
const pumpTemp = NUMERIC_MEASUREMENTS.pump[0].signal;
const pumpFlow = NUMERIC_MEASUREMENTS.pump[3].signal;

describe('Rng', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const a = new Rng(1);
    const b = new Rng(1);
    const c = new Rng(2);
    const seqA = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(seqA);
  });

  it('produces uniform values in [0, 1) and roughly standard normal gaussians', () => {
    const rng = new Rng(7);
    const uniform = Array.from({ length: 10_000 }, () => rng.next());
    expect(Math.min(...uniform)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...uniform)).toBeLessThan(1);
    const g = Array.from({ length: 20_000 }, () => rng.gaussian());
    const mean = g.reduce((s, x) => s + x, 0) / g.length;
    const variance = g.reduce((s, x) => s + (x - mean) ** 2, 0) / g.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(Math.sqrt(variance) - 1)).toBeLessThan(0.05);
  });

  it('derives distinct seeds from distinct parts', () => {
    expect(hashSeed(42, 'pump-01', 'load')).toBe(hashSeed(42, 'pump-01', 'load'));
    expect(hashSeed(42, 'pump-01', 'load')).not.toBe(hashSeed(42, 'pump-02', 'load'));
  });
});

describe('LoadModel', () => {
  it('stays within running bounds and drops to idle in idle windows', () => {
    const model = new LoadModel(new Rng(3), [{ startOffsetSec: 600, durationSec: 300 }]);
    for (let t = 0; t < 600_000; t += 5_000) {
      const load = model.at(t);
      expect(load).toBeGreaterThanOrEqual(0.3);
      expect(load).toBeLessThanOrEqual(1);
    }
    expect(model.at(700_000)).toBe(IDLE_LOAD);
    expect(model.isIdle(700_000)).toBe(true);
    expect(model.isIdle(900_000)).toBe(false);
  });

  it('treats windows as half-open [start, end)', () => {
    const w = { startOffsetSec: 10, durationSec: 5 };
    expect(isInWindow(w, 9_999)).toBe(false);
    expect(isInWindow(w, 10_000)).toBe(true);
    expect(isInWindow(w, 15_000)).toBe(false);
  });
});

describe('SignalModel', () => {
  const quiet = { ...pumpTemp, noiseStdDev: 0, dailyAmplitude: 0, driftPerHour: 0 };

  it('makes temperature lag a load step while flow follows it at once (FR-SIM-2)', () => {
    const temp = new SignalModel(quiet, new Rng(1));
    const flow = new SignalModel({ ...pumpFlow, noiseStdDev: 0, dailyAmplitude: 0 }, new Rng(1));
    temp.sample(0, 0, 0.3);
    flow.sample(0, 0, 0.3);
    const tempAfter = temp.sample(5_000, 5_000, 1);
    const flowAfter = flow.sample(5_000, 5_000, 1);
    expect(flowAfter).toBeCloseTo(pumpFlow.base, 5);
    // Temperature starts at 49.5 (load 0.3); 5 s into a 120 s lag it has barely moved.
    const tempAtLowLoad = quiet.base * (1 - quiet.loadSensitivity * 0.7);
    expect(tempAfter).toBeGreaterThan(tempAtLowLoad);
    expect(tempAfter).toBeLessThan(tempAtLowLoad + 1);
    // After many lag constants, temperature reaches its full-load value.
    expect(temp.sample(3_600_000, 3_600_000, 1)).toBeCloseTo(quiet.base, 3);
  });

  it('adds drift over time', () => {
    const drifting = new SignalModel({ ...quiet, lagSeconds: 0, driftPerHour: 2 }, new Rng(1));
    const start = drifting.sample(0, 0, 1);
    expect(drifting.sample(3_600_000, 3_600_000, 1) - start).toBeCloseTo(2, 5);
  });

  it('clamps to physical limits', () => {
    const wild = new SignalModel({ ...pumpTemp, noiseStdDev: 1_000 }, new Rng(9));
    for (let i = 0; i < 200; i++) {
      const v = wild.sample(i * 5_000, i * 5_000, 1);
      expect(v).toBeGreaterThanOrEqual(pumpTemp.min);
      expect(v).toBeLessThanOrEqual(pumpTemp.max);
    }
    expect(clamp(5, 0, 1)).toBe(1);
    expect(round2(1.006)).toBe(1.01);
  });
});

describe('FaultEngine (FR-SIM-3)', () => {
  const base = { temperature_c: 60, vibration_mm_s: 3, pressure_bar: 5, flow_lpm: 200 };
  const parse = (f: unknown) => FaultSpec.parse(f);

  it('ramps vibration during bearing wear and only inside the window', () => {
    const engine = new FaultEngine([
      parse({ kind: 'bearingWear', machineId: 'p', startOffsetSec: 60, durationSec: 600 }),
    ]);
    expect(engine.apply(30_000, base).vibration_mm_s).toBe(3);
    expect(engine.apply(60_000, base).vibration_mm_s).toBe(3);
    expect(engine.apply(60_000 + 150_000, base).vibration_mm_s).toBeCloseTo(3 * 2.25);
    expect(engine.apply(60_000 + 300_000, base).vibration_mm_s).toBeCloseTo(3 * 3.5);
    expect(engine.apply(60_000 + 500_000, base).vibration_mm_s).toBeCloseTo(3 * 3.5);
    expect(engine.apply(661_000, base).vibration_mm_s).toBe(3);
  });

  it('steps then raises temperature during overheat', () => {
    const engine = new FaultEngine([
      parse({ kind: 'overheat', machineId: 'p', startOffsetSec: 0, durationSec: 600 }),
    ]);
    expect(engine.apply(0, base).temperature_c).toBe(75);
    expect(engine.apply(5 * MIN, base).temperature_c).toBe(80);
  });

  it('freezes a stuck sensor, then releases it', () => {
    const engine = new FaultEngine([
      parse({
        kind: 'stuckSensor',
        machineId: 'p',
        measurement: 'flow_lpm',
        startOffsetSec: 10,
        durationSec: 20,
      }),
    ]);
    expect(engine.apply(10_000, { ...base, flow_lpm: 111 }).flow_lpm).toBe(111);
    expect(engine.apply(20_000, { ...base, flow_lpm: 222 }).flow_lpm).toBe(111);
    expect(engine.apply(30_000, { ...base, flow_lpm: 333 }).flow_lpm).toBe(333);
  });

  it('reports dropout only inside its window', () => {
    const engine = new FaultEngine([
      parse({ kind: 'dropout', machineId: 'p', startOffsetSec: 5, durationSec: 5 }),
    ]);
    expect(engine.isDroppedOut(4_999)).toBe(false);
    expect(engine.isDroppedOut(5_000)).toBe(true);
    expect(engine.isDroppedOut(10_000)).toBe(false);
    expect(engine.apply(6_000, base)).toEqual(base);
  });

  it('ignores faults for signals a machine does not have', () => {
    const engine = new FaultEngine([
      parse({ kind: 'bearingWear', machineId: 'p', startOffsetSec: 0, durationSec: 10 }),
      parse({ kind: 'overheat', machineId: 'p', startOffsetSec: 0, durationSec: 10 }),
      parse({
        kind: 'stuckSensor',
        machineId: 'p',
        measurement: 'rpm',
        startOffsetSec: 0,
        durationSec: 10,
      }),
    ]);
    expect(engine.apply(1_000, { flow_lpm: 1 })).toEqual({ flow_lpm: 1 });
  });

  it('applies defaults and rejects unknown fields', () => {
    expect(
      parse({ kind: 'bearingWear', machineId: 'p', startOffsetSec: 0, durationSec: 1 }),
    ).toMatchObject({ peakMultiplier: 3.5, rampSec: 300 });
    expect(() =>
      parse({ kind: 'dropout', machineId: 'p', startOffsetSec: 0, durationSec: 1, x: 1 }),
    ).toThrow();
  });
});

describe('deriveStatus (FR-SIM-4)', () => {
  const wear = FaultSpec.parse({
    kind: 'bearingWear',
    machineId: 'p',
    startOffsetSec: 0,
    durationSec: 1,
  });
  const heat = FaultSpec.parse({
    kind: 'overheat',
    machineId: 'p',
    startOffsetSec: 0,
    durationSec: 1,
  });
  const stuck = FaultSpec.parse({
    kind: 'stuckSensor',
    machineId: 'p',
    measurement: 'flow_lpm',
    startOffsetSec: 0,
    durationSec: 1,
  });
  const ok = { temperature_c: 60, vibration_mm_s: 3 };

  it('is RUNNING normally and IDLE in idle windows', () => {
    expect(deriveStatus({ type: 'pump', idle: false, activeFaults: [], values: ok })).toBe(
      'RUNNING',
    );
    expect(deriveStatus({ type: 'pump', idle: true, activeFaults: [], values: ok })).toBe('IDLE');
  });

  it('is FAULT only once an active fault crosses its threshold', () => {
    const high = { ...ok, vibration_mm_s: VIBRATION_ALERT_THRESHOLD_MM_S + 0.1 };
    expect(deriveStatus({ type: 'pump', idle: false, activeFaults: [wear], values: ok })).toBe(
      'RUNNING',
    );
    expect(deriveStatus({ type: 'pump', idle: false, activeFaults: [wear], values: high })).toBe(
      'FAULT',
    );
    // High vibration without an active fault is noise, not a fault.
    expect(deriveStatus({ type: 'pump', idle: false, activeFaults: [], values: high })).toBe(
      'RUNNING',
    );
  });

  it('uses per-type overheat thresholds', () => {
    const hot = { ...ok, temperature_c: 85 };
    expect(deriveStatus({ type: 'pump', idle: false, activeFaults: [heat], values: hot })).toBe(
      'FAULT',
    );
    expect(
      deriveStatus({ type: 'compressor', idle: false, activeFaults: [heat], values: hot }),
    ).toBe('RUNNING');
  });

  it('keeps a stuck sensor silent', () => {
    expect(deriveStatus({ type: 'pump', idle: false, activeFaults: [stuck], values: ok })).toBe(
      'RUNNING',
    );
  });
});
