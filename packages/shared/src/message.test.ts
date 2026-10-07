import { describe, expect, it } from 'vitest';
import {
  isWithinSiteWiseWindow,
  MESSAGE_SIZE_TARGET_BYTES,
  messageSizeBytes,
  parseTelemetryMessage,
  TelemetryMessageV1,
} from './message.js';

const pumpMessage = {
  v: 1,
  ts: 1791375084123,
  seq: 48211,
  machineId: 'pump-01',
  metrics: { temperature_c: 61.42, vibration_mm_s: 3.18, pressure_bar: 4.95, flow_lpm: 212.7 },
  status: 'RUNNING',
};

const compressorMessage = {
  ...pumpMessage,
  machineId: 'comp-01',
  metrics: {
    temperature_c: 75.1,
    vibration_mm_s: 4.2,
    discharge_pressure_bar: 8.1,
    motor_current_a: 45.3,
  },
};

describe('TelemetryMessageV1', () => {
  it('accepts the SRS 5.2 example payload', () => {
    expect(parseTelemetryMessage('pump', pumpMessage)).toEqual(pumpMessage);
    expect(TelemetryMessageV1.safeParse(pumpMessage).success).toBe(true);
  });

  it('accepts a compressor payload', () => {
    expect(parseTelemetryMessage('compressor', compressorMessage)).toEqual(compressorMessage);
  });

  it("rejects a payload carrying another type's metrics", () => {
    expect(() => parseTelemetryMessage('compressor', pumpMessage)).toThrow(
      /Invalid compressor telemetry message/,
    );
  });

  it.each([
    ['wrong version', { v: 2 }],
    ['epoch seconds instead of ms', { ts: 1791375084 }],
    ['fractional ts', { ts: 1791375084123.5 }],
    ['negative seq', { seq: -1 }],
    ['unknown status', { status: 'BROKEN' }],
    ['invalid machineId', { machineId: 'Pump 01' }],
    ['unknown top-level field', { extra: true }],
    ['NaN metric', { metrics: { ...pumpMessage.metrics, flow_lpm: Number.NaN } }],
    ['infinite metric', { metrics: { ...pumpMessage.metrics, flow_lpm: Infinity } }],
    ['string metric', { metrics: { ...pumpMessage.metrics, flow_lpm: '212.7' } }],
    ['missing metric', { metrics: { temperature_c: 1, vibration_mm_s: 1, pressure_bar: 1 } }],
    ['extra metric', { metrics: { ...pumpMessage.metrics, rpm: 1450 } }],
  ])('rejects %s', (_case, patch) => {
    expect(() => parseTelemetryMessage('pump', { ...pumpMessage, ...patch })).toThrow();
  });

  it('stays under 1 KB even with long ids and full-precision values', () => {
    const worst = {
      ...compressorMessage,
      machineId: 'm'.repeat(64),
      seq: Number.MAX_SAFE_INTEGER,
      metrics: {
        temperature_c: -123.45678901234567,
        vibration_mm_s: 12.345678901234567,
        discharge_pressure_bar: 15.999999999999998,
        motor_current_a: 119.99999999999999,
      },
      status: 'RUNNING' as const,
    };
    const parsed = parseTelemetryMessage('compressor', worst);
    expect(messageSizeBytes(parsed)).toBeLessThan(MESSAGE_SIZE_TARGET_BYTES);
  });
});

describe('isWithinSiteWiseWindow', () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const day = 24 * 60 * 60 * 1000;

  it('accepts values up to 7 days old and 10 minutes ahead (inclusive)', () => {
    expect(isWithinSiteWiseWindow(now, now)).toBe(true);
    expect(isWithinSiteWiseWindow(now - 7 * day, now)).toBe(true);
    expect(isWithinSiteWiseWindow(now + 10 * 60_000, now)).toBe(true);
  });

  it('rejects values outside the window', () => {
    expect(isWithinSiteWiseWindow(now - 7 * day - 1, now)).toBe(false);
    expect(isWithinSiteWiseWindow(now + 10 * 60_000 + 1, now)).toBe(false);
  });
});
