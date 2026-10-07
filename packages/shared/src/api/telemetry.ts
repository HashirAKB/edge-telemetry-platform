import { z } from 'zod';
import { AssetId, IsoTimestamp, PropertyId, PropertyValue, Quality } from './common.js';
import { PropertyKind } from './assets.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Default simulator publish interval (FR-SIM-1). */
export const DEFAULT_PUBLISH_INTERVAL_MS = 5_000;
/** Latest values are stale when older than 3 x the expected interval (FR-API-4). */
export const STALE_INTERVAL_MULTIPLIER = 3;

// ---------- Latest values (FR-API-4) ----------

export const LatestValue = z
  .object({
    propertyId: PropertyId,
    name: z.string(),
    kind: PropertyKind,
    value: PropertyValue.nullable(),
    timestamp: IsoTimestamp.nullable(),
    quality: Quality.nullable(),
  })
  .meta({ id: 'LatestValue' });
export type LatestValue = z.infer<typeof LatestValue>;

export const LatestValuesResponse = z
  .object({
    assetId: AssetId,
    /** True when the newest measurement is older than `staleAfterSeconds`. */
    stale: z.boolean(),
    staleAfterSeconds: z.number(),
    newestMeasurementAt: IsoTimestamp.nullable(),
    values: z.array(LatestValue),
  })
  .meta({ id: 'LatestValuesResponse' });
export type LatestValuesResponse = z.infer<typeof LatestValuesResponse>;

/**
 * Staleness is judged on measurements only: metrics such as 5 minute windows are
 * legitimately older than a few publish intervals.
 */
export function isStale(
  newestMeasurementMs: number | null,
  nowMs: number,
  intervalMs: number = DEFAULT_PUBLISH_INTERVAL_MS,
): boolean {
  if (newestMeasurementMs === null) return true;
  return nowMs - newestMeasurementMs > STALE_INTERVAL_MULTIPLIER * intervalMs;
}

// ---------- Raw history (FR-API-5) ----------

export const HISTORY_MAX_RANGE_MS = DAY_MS;
export const HISTORY_DEFAULT_LIMIT = 250;
export const HISTORY_MAX_LIMIT = 1000;

interface TimeRange {
  from: string;
  to: string;
}

/** Adds `from < to` and a maximum span to a query that has ISO `from`/`to`. */
function checkRange(range: TimeRange, maxMs: number, ctx: z.RefinementCtx, label: string): void {
  const span = Date.parse(range.to) - Date.parse(range.from);
  if (span <= 0) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: '`to` must be after `from`' });
  } else if (span > maxMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['to'],
      message: `range must not exceed ${formatDuration(maxMs)} ${label}`,
    });
  }
}

function formatDuration(ms: number): string {
  return ms % DAY_MS === 0 ? `${ms / DAY_MS}d` : `${ms / HOUR_MS}h`;
}

export const HistoryQuery = z
  .object({
    from: IsoTimestamp,
    to: IsoTimestamp,
    limit: z.coerce.number().int().min(1).max(HISTORY_MAX_LIMIT).default(HISTORY_DEFAULT_LIMIT),
    /** Opaque token from a previous page; passed through to SiteWise unchanged. */
    nextToken: z.string().min(1).max(4096).optional(),
  })
  .superRefine((q, ctx) => {
    checkRange(q, HISTORY_MAX_RANGE_MS, ctx, 'for raw history');
  });
export type HistoryQuery = z.infer<typeof HistoryQuery>;

export const HistoryPoint = z
  .object({ timestamp: IsoTimestamp, value: PropertyValue, quality: Quality })
  .meta({ id: 'HistoryPoint' });

export const HistoryResponse = z
  .object({
    assetId: AssetId,
    propertyId: PropertyId,
    values: z.array(HistoryPoint),
    nextToken: z.string().optional(),
  })
  .meta({ id: 'HistoryResponse' });
export type HistoryResponse = z.infer<typeof HistoryResponse>;

// ---------- Aggregates (FR-API-6) ----------

export const AGGREGATE_RESOLUTIONS = ['1m', '15m', '1h', '1d'] as const;
export const AggregateResolution = z.enum(AGGREGATE_RESOLUTIONS);
export type AggregateResolution = z.infer<typeof AggregateResolution>;

export const AGGREGATE_TYPES = [
  'AVERAGE',
  'MINIMUM',
  'MAXIMUM',
  'COUNT',
  'SUM',
  'STANDARD_DEVIATION',
] as const;
export const AggregateType = z.enum(AGGREGATE_TYPES);
export type AggregateType = z.infer<typeof AggregateType>;

/**
 * Maximum range per resolution. Each cap keeps a response at or under 1,440 points
 * (24 h of 1 minute buckets), which bounds Lambda memory and latency (NFR-1).
 */
export const AGGREGATE_MAX_RANGE_MS: Readonly<Record<AggregateResolution, number>> = {
  '1m': DAY_MS,
  '15m': 7 * DAY_MS,
  '1h': 30 * DAY_MS,
  '1d': 366 * DAY_MS,
};

/** `types` arrives as a comma-separated query string, e.g. `AVERAGE,MAXIMUM`. */
const AggregateTypesParam = z
  .string()
  .default('AVERAGE')
  .transform((raw) => [...new Set(raw.split(',').map((s) => s.trim()))])
  .pipe(z.array(AggregateType).min(1))
  .meta({
    description: `Comma-separated subset of ${AGGREGATE_TYPES.join(', ')}`,
    example: 'AVERAGE,MAXIMUM',
  });

export const AggregatesQuery = z
  .object({
    from: IsoTimestamp,
    to: IsoTimestamp,
    resolution: AggregateResolution,
    types: AggregateTypesParam,
  })
  .superRefine((q, ctx) => {
    checkRange(q, AGGREGATE_MAX_RANGE_MS[q.resolution], ctx, `at ${q.resolution} resolution`);
  });
export type AggregatesQuery = z.infer<typeof AggregatesQuery>;

export const AggregatePoint = z
  .object({
    timestamp: IsoTimestamp,
    values: z.partialRecord(AggregateType, z.number()),
  })
  .meta({ id: 'AggregatePoint' });

export const AggregatesResponse = z
  .object({
    assetId: AssetId,
    propertyId: PropertyId,
    resolution: AggregateResolution,
    points: z.array(AggregatePoint),
  })
  .meta({ id: 'AggregatesResponse' });
export type AggregatesResponse = z.infer<typeof AggregatesResponse>;

export const PropertyParams = z.object({ assetId: AssetId, propertyId: PropertyId });
