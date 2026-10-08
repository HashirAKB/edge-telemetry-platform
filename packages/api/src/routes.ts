import {
  AggregatesQuery,
  AssetByKeyParams,
  AssetIdParams,
  HistoryQuery,
  PropertyParams,
  type HealthResponse,
} from '@etp/shared';
import { parseOrThrow } from './http/errors.js';
import type { RouteImpl } from './http/app.js';
import type { CatalogService } from './services/catalog.js';
import type { TelemetryService } from './services/telemetry.js';

/** asset-catalog Lambda: FR-API-1, 2, 3, 7. */
export function catalogRoutes(catalog: CatalogService, version: string): Record<string, RouteImpl> {
  return {
    'FR-API-1': () => catalog.tree(),
    'FR-API-2': ({ params }) => {
      const { assetId } = parseOrThrow(AssetIdParams, params, 'path parameters');
      return catalog.asset(assetId);
    },
    'FR-API-3': ({ params }) => {
      const p = parseOrThrow(AssetByKeyParams, params, 'path parameters');
      return catalog.assetByKey(p.siteId, p.lineId, p.machineId);
    },
    'FR-API-7': async (): Promise<HealthResponse> => {
      const reachable = await catalog.reachable();
      return {
        status: reachable ? 'ok' : 'degraded',
        version,
        sitewise: reachable ? 'reachable' : 'unreachable',
        checkedAt: new Date().toISOString(),
      };
    },
  };
}

/** telemetry-query Lambda: FR-API-4, 5, 6. */
export function telemetryRoutes(telemetry: TelemetryService): Record<string, RouteImpl> {
  return {
    'FR-API-4': ({ params }) => {
      const { assetId } = parseOrThrow(AssetIdParams, params, 'path parameters');
      return telemetry.latest(assetId);
    },
    'FR-API-5': ({ params, query }) => {
      const p = parseOrThrow(PropertyParams, params, 'path parameters');
      const q = parseOrThrow(HistoryQuery, query, 'query parameters');
      return telemetry.history(p.assetId, p.propertyId, q);
    },
    'FR-API-6': ({ params, query }) => {
      const p = parseOrThrow(PropertyParams, params, 'path parameters');
      const q = parseOrThrow(AggregatesQuery, query, 'query parameters');
      return telemetry.aggregates(p.assetId, p.propertyId, q);
    },
  };
}
