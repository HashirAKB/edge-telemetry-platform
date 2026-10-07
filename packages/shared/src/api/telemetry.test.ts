import { describe, expect, it } from 'vitest';
import {
  AGGREGATE_MAX_RANGE_MS,
  AGGREGATE_RESOLUTIONS,
  AggregatesQuery,
  HistoryQuery,
  isStale,
  LatestValuesResponse,
} from './telemetry.js';

const from = '2026-10-07T00:00:00Z';
const hoursLater = (h: number) => new Date(Date.parse(from) + h * 3_600_000).toISOString();

function issues(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.error?.issues.map((i) => i.message).join('; ') ?? '';
}

describe('HistoryQuery (FR-API-5)', () => {
  it('applies the default limit and coerces query-string numbers', () => {
    expect(HistoryQuery.parse({ from, to: hoursLater(1) }).limit).toBe(250);
    expect(HistoryQuery.parse({ from, to: hoursLater(1), limit: '1000' }).limit).toBe(1000);
  });

  it('passes nextToken through unchanged', () => {
    const q = HistoryQuery.parse({ from, to: hoursLater(1), nextToken: 'opaque==' });
    expect(q.nextToken).toBe('opaque==');
  });

  it('accepts exactly 24 hours and rejects more', () => {
    expect(HistoryQuery.safeParse({ from, to: hoursLater(24) }).success).toBe(true);
    const tooLong = HistoryQuery.safeParse({ from, to: hoursLater(25) });
    expect(issues(tooLong)).toMatch(/must not exceed 1d for raw history/);
  });

  it.each([
    ['to before from', { from: hoursLater(2), to: from }, /after `from`/],
    ['to equal to from', { from, to: from }, /after `from`/],
    ['limit 0', { from, to: hoursLater(1), limit: '0' }, /./],
    ['limit over 1000', { from, to: hoursLater(1), limit: '1001' }, /./],
    ['fractional limit', { from, to: hoursLater(1), limit: '2.5' }, /./],
    ['non-ISO from', { from: 'yesterday', to: hoursLater(1) }, /./],
    ['timestamp without offset', { from: '2026-10-07T00:00:00', to: hoursLater(1) }, /./],
    ['missing to', { from }, /./],
  ])('rejects %s', (_case, input, message) => {
    const result = HistoryQuery.safeParse(input);
    expect(result.success).toBe(false);
    expect(issues(result)).toMatch(message);
  });
});

describe('AggregatesQuery (FR-API-6)', () => {
  it('defaults types to AVERAGE', () => {
    const q = AggregatesQuery.parse({ from, to: hoursLater(1), resolution: '1m' });
    expect(q.types).toEqual(['AVERAGE']);
  });

  it('parses, trims, and de-duplicates comma-separated types', () => {
    const q = AggregatesQuery.parse({
      from,
      to: hoursLater(1),
      resolution: '1m',
      types: 'AVERAGE, MAXIMUM,AVERAGE',
    });
    expect(q.types).toEqual(['AVERAGE', 'MAXIMUM']);
  });

  it.each(['MEDIAN', '', 'AVERAGE,', 'average'])('rejects types=%j', (types) => {
    const q = { from, to: hoursLater(1), resolution: '1m', types };
    expect(AggregatesQuery.safeParse(q).success).toBe(false);
  });

  it('rejects an unknown resolution', () => {
    expect(AggregatesQuery.safeParse({ from, to: hoursLater(1), resolution: '5m' }).success).toBe(
      false,
    );
  });

  it.each(AGGREGATE_RESOLUTIONS)('enforces the range cap at %s resolution', (resolution) => {
    const maxHours = AGGREGATE_MAX_RANGE_MS[resolution] / 3_600_000;
    expect(AggregatesQuery.safeParse({ from, to: hoursLater(maxHours), resolution }).success).toBe(
      true,
    );
    const over = AggregatesQuery.safeParse({ from, to: hoursLater(maxHours + 1), resolution });
    expect(issues(over)).toMatch(new RegExp(`at ${resolution} resolution`));
  });

  it('keeps every allowed range at or under 1,440 points', () => {
    const bucketMs = { '1m': 60_000, '15m': 900_000, '1h': 3_600_000, '1d': 86_400_000 };
    for (const r of AGGREGATE_RESOLUTIONS) {
      expect(AGGREGATE_MAX_RANGE_MS[r] / bucketMs[r]).toBeLessThanOrEqual(1440);
    }
  });
});

describe('isStale (FR-API-4)', () => {
  const now = Date.UTC(2026, 9, 7, 12);

  it('is fresh within 3 x the publish interval', () => {
    expect(isStale(now - 15_000, now)).toBe(false);
  });

  it('is stale beyond 3 x the publish interval, or with no data', () => {
    expect(isStale(now - 15_001, now)).toBe(true);
    expect(isStale(null, now)).toBe(true);
  });

  it('scales with a custom interval', () => {
    expect(isStale(now - 25_000, now, 10_000)).toBe(false);
  });
});

describe('LatestValuesResponse', () => {
  it('allows null values for properties with no data yet', () => {
    const result = LatestValuesResponse.safeParse({
      assetId: '3f8e1d6a-2b4c-4d5e-8f60-1a2b3c4d5e6f',
      stale: true,
      staleAfterSeconds: 15,
      newestMeasurementAt: null,
      values: [
        {
          propertyId: '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b',
          name: 'max_vibration_5m',
          kind: 'metric',
          value: null,
          timestamp: null,
          quality: null,
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
