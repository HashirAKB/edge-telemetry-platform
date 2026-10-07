import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import type { z } from 'zod';
import { CONTRACT_VERSION } from '../version.js';
import { AssetByKeyParams, AssetDetail, AssetIdParams, AssetTreeResponse } from './assets.js';
import { Problem, PROBLEM_CONTENT_TYPE } from './common.js';
import { HealthResponse } from './health.js';
import {
  AggregatesQuery,
  AggregatesResponse,
  HistoryQuery,
  HistoryResponse,
  LatestValuesResponse,
  PropertyParams,
} from './telemetry.js';

export const API_BASE_PATH = `/v${CONTRACT_VERSION}`;
export const API_KEY_HEADER = 'x-api-key';

export type ApiService = 'asset-catalog' | 'telemetry-query';

export interface ApiRoute {
  readonly id: string;
  readonly method: 'get';
  /** Path with `{param}` placeholders, as API Gateway and OpenAPI both expect. */
  readonly path: string;
  readonly service: ApiService;
  readonly requiresApiKey: boolean;
  readonly summary: string;
  readonly params?: z.ZodObject;
  readonly query?: z.ZodObject;
  readonly response: z.ZodType;
}

/**
 * Every route of the query API (SRS 6.5). Infra builds API Gateway resources from this list
 * and the OpenAPI document is generated from it, so they cannot drift apart.
 */
export const API_ROUTES: readonly ApiRoute[] = [
  {
    id: 'FR-API-1',
    method: 'get',
    path: `${API_BASE_PATH}/assets/tree`,
    service: 'asset-catalog',
    requiresApiKey: true,
    summary: 'Full asset hierarchy: site, lines, machines, and their properties',
    response: AssetTreeResponse,
  },
  {
    id: 'FR-API-2',
    method: 'get',
    path: `${API_BASE_PATH}/assets/{assetId}`,
    service: 'asset-catalog',
    requiresApiKey: true,
    summary: 'One asset with its properties and child asset IDs',
    params: AssetIdParams,
    response: AssetDetail,
  },
  {
    id: 'FR-API-3',
    method: 'get',
    path: `${API_BASE_PATH}/assets/by-key/{siteId}/{lineId}/{machineId}`,
    service: 'asset-catalog',
    requiresApiKey: true,
    summary: 'Resolve a topology key (site/line/machine IDs) to an asset',
    params: AssetByKeyParams,
    response: AssetDetail,
  },
  {
    id: 'FR-API-4',
    method: 'get',
    path: `${API_BASE_PATH}/assets/{assetId}/latest`,
    service: 'telemetry-query',
    requiresApiKey: true,
    summary: 'Latest value, timestamp, and quality for every property of an asset',
    params: AssetIdParams,
    response: LatestValuesResponse,
  },
  {
    id: 'FR-API-5',
    method: 'get',
    path: `${API_BASE_PATH}/assets/{assetId}/properties/{propertyId}/history`,
    service: 'telemetry-query',
    requiresApiKey: true,
    summary: 'Raw values for one property (max 24 h range, paginated)',
    params: PropertyParams,
    query: HistoryQuery,
    response: HistoryResponse,
  },
  {
    id: 'FR-API-6',
    method: 'get',
    path: `${API_BASE_PATH}/assets/{assetId}/properties/{propertyId}/aggregates`,
    service: 'telemetry-query',
    requiresApiKey: true,
    summary: 'Aggregates for one property at 1m, 15m, 1h, or 1d resolution',
    params: PropertyParams,
    query: AggregatesQuery,
    response: AggregatesResponse,
  },
  {
    id: 'FR-API-7',
    method: 'get',
    path: `${API_BASE_PATH}/health`,
    service: 'asset-catalog',
    requiresApiKey: false,
    summary: 'Build version and SiteWise reachability (no API key)',
    response: HealthResponse,
  },
];

const SECURITY_SCHEME = 'ApiKey';

function problemResponse(description: string) {
  return { description, content: { [PROBLEM_CONTENT_TYPE]: { schema: Problem } } };
}

export function buildOpenApiRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', SECURITY_SCHEME, {
    type: 'apiKey',
    in: 'header',
    name: API_KEY_HEADER,
  });

  for (const route of API_ROUTES) {
    registry.registerPath({
      method: route.method,
      path: route.path,
      operationId: route.id,
      summary: route.summary,
      tags: [route.service],
      ...(route.requiresApiKey ? { security: [{ [SECURITY_SCHEME]: [] }] } : {}),
      request: {
        ...(route.params ? { params: route.params } : {}),
        ...(route.query ? { query: route.query } : {}),
      },
      responses: {
        200: { description: 'OK', content: { 'application/json': { schema: route.response } } },
        ...(route.params || route.query
          ? { 400: problemResponse('Invalid path or query parameters') }
          : {}),
        ...(route.requiresApiKey ? { 403: { description: 'Missing or invalid API key' } } : {}),
        ...(route.params ? { 404: problemResponse('Asset or property not found') } : {}),
        429: { description: 'Throttled by the usage plan' },
        500: problemResponse('Unexpected server error'),
      },
    });
  }
  return registry;
}

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

export function generateOpenApiDocument(version: string): OpenApiDocument {
  return new OpenApiGeneratorV31(buildOpenApiRegistry().definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Edge Telemetry Platform Query API',
      version,
      description:
        'Typed read API over the plant asset hierarchy. Application teams use asset and ' +
        'property IDs from this API and never deal with MQTT topics or SiteWise internals.',
    },
  });
}
