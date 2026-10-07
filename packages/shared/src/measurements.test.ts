import { describe, expect, it } from 'vitest';
import {
  MACHINE_TYPES,
  measurementNamesFor,
  NUMERIC_MEASUREMENTS,
  numericMeasurementsFor,
} from './measurements.js';
import { MEASUREMENT_NAME_PATTERN } from './ids.js';

describe('measurements', () => {
  it('matches SRS 4.2 for pumps', () => {
    expect(measurementNamesFor('pump')).toEqual([
      'temperature_c',
      'vibration_mm_s',
      'pressure_bar',
      'flow_lpm',
      'status',
    ]);
  });

  it('matches SRS 4.2 for compressors', () => {
    expect(measurementNamesFor('compressor')).toEqual([
      'temperature_c',
      'vibration_mm_s',
      'discharge_pressure_bar',
      'motor_current_a',
      'status',
    ]);
  });

  it.each(MACHINE_TYPES)('has unique, alias-safe names for %s', (type) => {
    const names = measurementNamesFor(type);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(MEASUREMENT_NAME_PATTERN);
  });

  it.each(MACHINE_TYPES)('has physically sensible signal profiles for %s', (type) => {
    for (const m of numericMeasurementsFor(type)) {
      const s = m.signal;
      expect(s.min, m.name).toBeLessThan(s.max);
      expect(s.base, m.name).toBeGreaterThan(s.min);
      expect(s.base, m.name).toBeLessThan(s.max);
      expect(s.loadSensitivity, m.name).toBeGreaterThanOrEqual(0);
      expect(s.loadSensitivity, m.name).toBeLessThanOrEqual(1);
      expect(s.noiseStdDev, m.name).toBeGreaterThan(0);
      expect(s.lagSeconds, m.name).toBeGreaterThanOrEqual(0);
    }
  });

  it('makes temperature lag load while flow follows it instantly (FR-SIM-2)', () => {
    const pump = Object.fromEntries(NUMERIC_MEASUREMENTS.pump.map((m) => [m.name, m.signal]));
    expect(pump.temperature_c?.lagSeconds).toBeGreaterThan(0);
    expect(pump.flow_lpm?.lagSeconds).toBe(0);
  });
});
