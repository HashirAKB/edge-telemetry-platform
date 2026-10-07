import { describe, expect, it } from 'vitest';
import { API_BASE_PATH, API_KEY_HEADER, API_ROUTES, generateOpenApiDocument } from './routes.js';

describe('API_ROUTES', () => {
  it('covers FR-API-1 to FR-API-7 under /v1', () => {
    expect(API_ROUTES.map((r) => r.id)).toEqual([
      'FR-API-1',
      'FR-API-2',
      'FR-API-3',
      'FR-API-4',
      'FR-API-5',
      'FR-API-6',
      'FR-API-7',
    ]);
    for (const route of API_ROUTES) expect(route.path.startsWith(`${API_BASE_PATH}/`)).toBe(true);
  });

  it('requires an API key on every route except health (FR-API-9)', () => {
    const open = API_ROUTES.filter((r) => !r.requiresApiKey).map((r) => r.path);
    expect(open).toEqual(['/v1/health']);
  });

  it('declares a params schema for every path placeholder', () => {
    for (const route of API_ROUTES) {
      const placeholders = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const declared = Object.keys(route.params?.shape ?? {});
      expect(declared.sort(), route.path).toEqual(placeholders.sort());
    }
  });
});

describe('generateOpenApiDocument (FR-API-8)', () => {
  const doc = generateOpenApiDocument('1.2.3');

  it('produces an OpenAPI 3.1 document with every route', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe('1.2.3');
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(API_ROUTES.map((r) => r.path).sort());
  });

  it('declares the API key header and applies it per route', () => {
    expect(doc.components?.securitySchemes?.ApiKey).toEqual({
      type: 'apiKey',
      in: 'header',
      name: API_KEY_HEADER,
    });
    expect(doc.paths?.['/v1/assets/tree']?.get?.security).toEqual([{ ApiKey: [] }]);
    expect(doc.paths?.['/v1/health']?.get?.security).toBeUndefined();
  });

  it('publishes named component schemas, including the recursive tree node', () => {
    const schemas = doc.components?.schemas ?? {};
    for (const name of ['AssetTreeNode', 'AssetDetail', 'LatestValuesResponse', 'Problem']) {
      expect(schemas, name).toHaveProperty(name);
    }
    expect(JSON.stringify(schemas.AssetTreeNode)).toContain('#/components/schemas/AssetTreeNode');
  });

  it('documents query parameters for history and aggregates', () => {
    const params = (path: string) =>
      (doc.paths?.[path]?.get?.parameters ?? []).map((p) => ('name' in p ? p.name : ''));
    expect(params('/v1/assets/{assetId}/properties/{propertyId}/history')).toEqual(
      expect.arrayContaining(['assetId', 'propertyId', 'from', 'to', 'limit', 'nextToken']),
    );
    expect(params('/v1/assets/{assetId}/properties/{propertyId}/aggregates')).toEqual(
      expect.arrayContaining(['from', 'to', 'resolution', 'types']),
    );
  });

  it('uses problem+json for error responses', () => {
    const responses = doc.paths?.['/v1/assets/{assetId}']?.get?.responses ?? {};
    expect(Object.keys(responses)).toEqual(
      expect.arrayContaining(['200', '400', '403', '404', '429', '500']),
    );
    expect(JSON.stringify(responses['404'])).toContain('application/problem+json');
  });
});
