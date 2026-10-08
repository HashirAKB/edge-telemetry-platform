import {
  DEFAULT_PUBLISH_INTERVAL_MS,
  isStale,
  STALE_INTERVAL_MULTIPLIER,
  type AggregatesQuery,
  type AggregatesResponse,
  type HistoryQuery,
  type HistoryResponse,
  type LatestValuesResponse,
} from '@etp/shared';
import { badRequest } from '../http/errors.js';
import type { SiteWiseReader } from '../sitewise/reader.js';
import type { CatalogService } from './catalog.js';

/**
 * Assets without measurements (lines, site) only have 5 minute metrics, which land a few
 * minutes after each window closes. Treat them as stale after two windows plus processing time.
 */
const METRIC_ONLY_STALE_AFTER_MS = 11 * 60_000;

export interface TelemetryOptions {
  readonly publishIntervalMs?: number;
  readonly now?: () => number;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class TelemetryService {
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(
    private readonly catalog: CatalogService,
    private readonly reader: SiteWiseReader,
    options: TelemetryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.intervalMs = options.publishIntervalMs ?? DEFAULT_PUBLISH_INTERVAL_MS;
  }

  /** FR-API-4: latest value of every property, plus staleness from the newest measurement. */
  async latest(assetId: string): Promise<LatestValuesResponse> {
    const node = await this.catalog.node(assetId);
    const tqvs = await this.reader.latestValues(
      node.properties.map((p) => ({ assetId, propertyId: p.propertyId })),
    );

    const hasMeasurements = node.properties.some((p) => p.kind === 'measurement');
    const freshnessKind = hasMeasurements ? 'measurement' : 'metric';
    let newest: number | null = null;
    for (const [i, p] of node.properties.entries()) {
      const t = tqvs[i]?.timestampMs;
      if (p.kind === freshnessKind && t !== undefined && (newest === null || t > newest))
        newest = t;
    }
    const staleAfterMs = hasMeasurements
      ? STALE_INTERVAL_MULTIPLIER * this.intervalMs
      : METRIC_ONLY_STALE_AFTER_MS;

    return {
      assetId,
      stale: isStale(newest, this.now(), staleAfterMs / STALE_INTERVAL_MULTIPLIER),
      staleAfterSeconds: staleAfterMs / 1000,
      newestMeasurementAt: newest === null ? null : iso(newest),
      values: node.properties.map((p, i) => {
        const tqv = tqvs[i] ?? null;
        return {
          propertyId: p.propertyId,
          name: p.name,
          kind: p.kind,
          value: tqv?.value ?? null,
          timestamp: tqv ? iso(tqv.timestampMs) : null,
          quality: tqv?.quality ?? null,
        };
      }),
    };
  }

  /** FR-API-5: raw values with opaque pagination passthrough. */
  async history(
    assetId: string,
    propertyId: string,
    query: HistoryQuery,
  ): Promise<HistoryResponse> {
    await this.catalog.property(assetId, propertyId);
    const page = await this.reader.history({
      assetId,
      propertyId,
      from: new Date(query.from),
      to: new Date(query.to),
      limit: query.limit,
      nextToken: query.nextToken,
    });
    return {
      assetId,
      propertyId,
      values: page.values.map((v) => ({
        timestamp: iso(v.timestampMs),
        value: v.value ?? '',
        quality: v.quality,
      })),
      ...(page.nextToken ? { nextToken: page.nextToken } : {}),
    };
  }

  /** FR-API-6: aggregates for numeric properties at a fixed resolution. */
  async aggregates(
    assetId: string,
    propertyId: string,
    query: AggregatesQuery,
  ): Promise<AggregatesResponse> {
    const property = await this.catalog.property(assetId, propertyId);
    if (property.dataType === 'STRING') {
      throw badRequest(`Property ${property.name} is a string; aggregates need a numeric property`);
    }
    const buckets = await this.reader.aggregates({
      assetId,
      propertyId,
      from: new Date(query.from),
      to: new Date(query.to),
      resolution: query.resolution,
      types: query.types,
    });
    return {
      assetId,
      propertyId,
      resolution: query.resolution,
      points: buckets.map((b) => ({ timestamp: iso(b.timestampMs), values: b.values })),
    };
  }
}
