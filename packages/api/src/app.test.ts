import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { PROBLEM_CONTENT_TYPE } from '@etp/shared';
import { createHandler } from './http/app.js';
import { catalogRoutes, telemetryRoutes } from './routes.js';
import { CatalogService } from './services/catalog.js';
import { TelemetryService } from './services/telemetry.js';
import { fakeObservability, FakeSiteWise } from './test-helpers.js';

const context = {} as Context;

function event(
  resource: string,
  path: string,
  params: Record<string, string> = {},
  query?: Record<string, string>,
) {
  return {
    resource,
    path,
    httpMethod: 'GET',
    pathParameters: params,
    queryStringParameters: query ?? null,
    requestContext: { requestId: 'req-1' },
  } as unknown as APIGatewayProxyEvent;
}

function setup() {
  const sitewise = new FakeSiteWise();
  const catalog = new CatalogService(sitewise, { rootExternalId: 'kochi-01' });
  const telemetry = new TelemetryService(catalog, sitewise);
  const obs = fakeObservability();
  const catalogHandler = createHandler({
    service: 'asset-catalog',
    routes: catalogRoutes(catalog, '1.2.3'),
    logger: obs.logger,
    metrics: obs.metrics,
  });
  const telemetryHandler = createHandler({
    service: 'telemetry-query',
    routes: telemetryRoutes(telemetry),
    logger: obs.logger,
    metrics: obs.metrics,
  });
  return { sitewise, obs, catalogHandler, telemetryHandler };
}

const body = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;

describe('asset-catalog handler', () => {
  it('serves the tree as JSON with CORS and no-store headers', async () => {
    const { catalogHandler } = setup();
    const res = await catalogHandler(event('/v1/assets/tree', '/v1/assets/tree'), context);
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    expect((body(res).site as { externalKey: string }).externalKey).toBe('kochi-01');
  });

  it('resolves by key and by id', async () => {
    const { sitewise, catalogHandler } = setup();
    const id = sitewise.id('kochi-01/line-a/pump-02');
    const byKey = await catalogHandler(
      event('/v1/assets/by-key/{siteId}/{lineId}/{machineId}', '/x', {
        siteId: 'kochi-01',
        lineId: 'line-a',
        machineId: 'pump-02',
      }),
      context,
    );
    expect(body(byKey).assetId).toBe(id);
    const byId = await catalogHandler(
      event('/v1/assets/{assetId}', '/x', { assetId: id }),
      context,
    );
    expect(body(byId).parentAssetId).toBe(sitewise.id('kochi-01/line-a'));
  });

  it('returns 400 problem+json listing each invalid field', async () => {
    const { catalogHandler } = setup();
    const res = await catalogHandler(
      event('/v1/assets/{assetId}', '/v1/assets/abc', { assetId: 'abc' }),
      context,
    );
    expect(res.statusCode).toBe(400);
    expect(res.headers?.['content-type']).toBe(PROBLEM_CONTENT_TYPE);
    expect(body(res)).toMatchObject({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      instance: '/v1/assets/abc',
      errors: [{ path: 'assetId', message: expect.any(String) as unknown }],
    });
  });

  it('returns 404 for well-formed ids outside the site and for unknown routes', async () => {
    const { catalogHandler } = setup();
    const missing = await catalogHandler(
      event('/v1/assets/{assetId}', '/x', { assetId: 'bbbbbbbb-0000-4000-8000-000000000001' }),
      context,
    );
    expect(missing.statusCode).toBe(404);
    const noRoute = await catalogHandler(event('/v1/nope', '/v1/nope'), context);
    expect(noRoute.statusCode).toBe(404);
  });

  it('reports health with version and SiteWise reachability (FR-API-7)', async () => {
    const { sitewise, catalogHandler } = setup();
    const ok = body(await catalogHandler(event('/v1/health', '/v1/health'), context));
    expect(ok).toMatchObject({ status: 'ok', version: '1.2.3', sitewise: 'reachable' });
    sitewise.failNext = new Error('down');
    const degraded = body(await catalogHandler(event('/v1/health', '/v1/health'), context));
    expect(degraded).toMatchObject({ status: 'degraded', sitewise: 'unreachable' });
  });

  it('refuses to start when a route has no implementation', () => {
    const { obs } = setup();
    expect(() =>
      createHandler({
        service: 'asset-catalog',
        routes: {},
        logger: obs.logger,
        metrics: obs.metrics,
      }),
    ).toThrow(/No implementation for FR-API-1/);
  });
});

describe('telemetry-query handler', () => {
  const pump = 'kochi-01/line-a/pump-01';

  it('serves latest values', async () => {
    const { sitewise, telemetryHandler } = setup();
    const res = await telemetryHandler(
      event('/v1/assets/{assetId}/latest', '/x', { assetId: sitewise.id(pump) }),
      context,
    );
    expect(res.statusCode).toBe(200);
    expect(body(res)).toHaveProperty('stale', true);
  });

  it('rejects a history range over 24 h before calling SiteWise', async () => {
    const { sitewise, telemetryHandler } = setup();
    const res = await telemetryHandler(
      event(
        '/v1/assets/{assetId}/properties/{propertyId}/history',
        '/x',
        { assetId: sitewise.id(pump), propertyId: sitewise.propertyId(pump, 'temperature_c') },
        { from: '2026-10-08T00:00:00Z', to: '2026-10-09T01:00:00Z' },
      ),
      context,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(body(res).errors)).toContain('must not exceed 1d');
    expect(sitewise.calls.history).toHaveLength(0);
  });

  it('maps SiteWise throttling to 503 with retry-after', async () => {
    const { sitewise, telemetryHandler } = setup();
    const assetId = sitewise.id(pump);
    await telemetryHandler(event('/v1/assets/{assetId}/latest', '/x', { assetId }), context);
    sitewise.failNext = Object.assign(new Error('rate'), { name: 'ThrottlingException' });
    const res = await telemetryHandler(
      event('/v1/assets/{assetId}/latest', '/x', { assetId }),
      context,
    );
    expect(res.statusCode).toBe(503);
    expect(res.headers?.['retry-after']).toBe('1');
  });

  it('hides internal errors behind a generic 500, logs them, and counts them', async () => {
    const { sitewise, obs, telemetryHandler } = setup();
    const assetId = sitewise.id(pump);
    await telemetryHandler(event('/v1/assets/{assetId}/latest', '/x', { assetId }), context);
    sitewise.failNext = new Error('secret internals');
    const res = await telemetryHandler(
      event('/v1/assets/{assetId}/latest', '/x', { assetId }),
      context,
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret internals');
    expect(obs.logs.some((l) => l.level === 'error' && l.message === 'Unhandled error')).toBe(true);
    const serverErrors = obs.recorded.filter((m) => m.name === 'ServerErrors');
    expect(serverErrors).toEqual([
      { name: 'ServerErrors', value: 1, dimensions: { route: 'FR-API-4' } },
    ]);
  });

  it('serves aggregates through the handler (FR-API-6)', async () => {
    const { sitewise, telemetryHandler } = setup();
    sitewise.aggregateBuckets = [{ timestampMs: Date.UTC(2026, 9, 9), values: { AVERAGE: 60 } }];
    const res = await telemetryHandler(
      event(
        '/v1/assets/{assetId}/properties/{propertyId}/aggregates',
        '/x',
        { assetId: sitewise.id(pump), propertyId: sitewise.propertyId(pump, 'temperature_c') },
        { from: '2026-10-08T12:00:00Z', to: '2026-10-09T12:00:00Z', resolution: '15m' },
      ),
      context,
    );
    expect(res.statusCode).toBe(200);
    expect(body(res)).toMatchObject({ resolution: '15m', points: [{ values: { AVERAGE: 60 } }] });
  });

  it('reports a non-object input as a single top-level error', async () => {
    const { parseOrThrow, ApiError } = await import('./http/errors.js');
    const { AssetIdParams } = await import('@etp/shared');
    try {
      parseOrThrow(AssetIdParams, 'not an object', 'path parameters');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as InstanceType<typeof ApiError>).errors?.[0]?.path).toBe('path parameters');
    }
    expect(new ApiError(418, 'Teapot').message).toBe('Teapot');
  });
});
