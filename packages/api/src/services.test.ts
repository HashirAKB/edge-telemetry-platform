import { describe, expect, it } from 'vitest';
import type { AssetTreeNode } from '@etp/shared';
import { CatalogService, TREE_TTL_MS } from './services/catalog.js';
import { TelemetryService } from './services/telemetry.js';
import { FakeSiteWise } from './test-helpers.js';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

function setup(now = () => NOW) {
  const sitewise = new FakeSiteWise();
  const catalog = new CatalogService(sitewise, { rootExternalId: 'kochi-01', now });
  const telemetry = new TelemetryService(catalog, sitewise, { now });
  return { sitewise, catalog, telemetry };
}

function count(node: AssetTreeNode, type: string): number {
  return (node.type === type ? 1 : 0) + node.children.reduce((n, c) => n + count(c, type), 0);
}

describe('CatalogService', () => {
  it('builds the full hierarchy with typed, labelled properties (FR-API-1)', async () => {
    const { catalog } = setup();
    const { site, generatedAt } = await catalog.tree();
    expect(generatedAt).toBe(new Date(NOW).toISOString());
    expect(site.externalKey).toBe('kochi-01');
    expect([
      count(site, 'site'),
      count(site, 'line'),
      count(site, 'pump'),
      count(site, 'compressor'),
    ]).toEqual([1, 2, 3, 2]);

    const pump = site.children[0]?.children.find(
      (c) => c.externalKey === 'kochi-01/line-a/pump-01',
    );
    const kinds = Object.fromEntries((pump?.properties ?? []).map((p) => [p.name, p.kind]));
    expect(kinds).toMatchObject({
      temperature_c: 'measurement',
      temperature_f: 'transform',
      avg_temperature_1m: 'metric',
    });
    const temp = pump?.properties.find((p) => p.name === 'temperature_c');
    expect(temp).toMatchObject({
      unit: 'Celsius',
      dataType: 'DOUBLE',
      alias: '/kochi-01/line-a/pump-01/temperature_c',
    });
    expect(site.properties.find((p) => p.name === 'timezone')?.kind).toBe('attribute');
  });

  it('serves the tree from memory for 5 minutes, then rebuilds', async () => {
    let now = NOW;
    const { sitewise, catalog } = setup(() => now);
    await catalog.tree();
    const callsAfterBuild = sitewise.calls.describeAsset;
    expect(callsAfterBuild).toBe(8);
    now += TREE_TTL_MS - 1;
    await catalog.tree();
    expect(sitewise.calls.describeAsset).toBe(callsAfterBuild);
    now += 1;
    await catalog.tree();
    expect(sitewise.calls.describeAsset).toBe(callsAfterBuild * 2);
  });

  it('shares one build between concurrent requests and never caches a failure', async () => {
    const { sitewise, catalog } = setup();
    await Promise.all([catalog.tree(), catalog.tree(), catalog.tree()]);
    expect(sitewise.calls.describeAsset).toBe(8);

    const fresh = setup();
    fresh.sitewise.failNext = new Error('boom');
    await expect(fresh.catalog.tree()).rejects.toThrow('boom');
    await expect(fresh.catalog.tree()).resolves.toBeDefined();
  });

  it('returns asset details with parent and children (FR-API-2)', async () => {
    const { sitewise, catalog } = setup();
    const line = await catalog.asset(sitewise.id('kochi-01/line-a'));
    expect(line.parentAssetId).toBe(sitewise.id('kochi-01'));
    expect(line.childAssetIds).toHaveLength(3);
    const site = await catalog.asset(sitewise.id('kochi-01'));
    expect(site.parentAssetId).toBeNull();
  });

  it('resolves topology keys (FR-API-3) and 404s for anything outside the site', async () => {
    const { sitewise, catalog } = setup();
    const pump = await catalog.assetByKey('kochi-01', 'line-b', 'pump-03');
    expect(pump.assetId).toBe(sitewise.id('kochi-01/line-b/pump-03'));
    await expect(catalog.assetByKey('kochi-01', 'line-b', 'pump-01')).rejects.toMatchObject({
      status: 404,
    });
    await expect(catalog.asset('bbbbbbbb-0000-4000-8000-000000000001')).rejects.toMatchObject({
      status: 404,
    });
    await expect(catalog.property(sitewise.id('kochi-01'), 'nope')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('reports SiteWise reachability without throwing', async () => {
    const { sitewise, catalog } = setup();
    await expect(catalog.reachable()).resolves.toBe(true);
    sitewise.failNext = new Error('network');
    await expect(catalog.reachable()).resolves.toBe(false);
  });
});

describe('TelemetryService', () => {
  const pump = 'kochi-01/line-a/pump-01';

  it('returns the latest value of every property and marks fresh data (FR-API-4)', async () => {
    const { sitewise, telemetry } = setup();
    sitewise.setValue(pump, 'temperature_c', {
      timestampMs: NOW - 5_000,
      quality: 'GOOD',
      value: 61.5,
    });
    sitewise.setValue(pump, 'status', {
      timestampMs: NOW - 5_000,
      quality: 'GOOD',
      value: 'RUNNING',
    });
    const latest = await telemetry.latest(sitewise.id(pump));
    expect(latest.stale).toBe(false);
    expect(latest.staleAfterSeconds).toBe(15);
    expect(latest.newestMeasurementAt).toBe(new Date(NOW - 5_000).toISOString());
    const temp = latest.values.find((v) => v.name === 'temperature_c');
    expect(temp).toMatchObject({ value: 61.5, quality: 'GOOD', kind: 'measurement' });
    const missing = latest.values.find((v) => v.name === 'max_vibration_5m');
    expect(missing).toMatchObject({ value: null, timestamp: null, quality: null });
  });

  it('marks data stale after 3 x the publish interval, or when there is none', async () => {
    const { sitewise, telemetry } = setup();
    expect((await telemetry.latest(sitewise.id(pump))).stale).toBe(true);
    sitewise.setValue(pump, 'temperature_c', {
      timestampMs: NOW - 15_001,
      quality: 'GOOD',
      value: 1,
    });
    expect((await telemetry.latest(sitewise.id(pump))).stale).toBe(true);
  });

  it('judges metric-only assets (lines) by their newest metric', async () => {
    const { sitewise, telemetry } = setup();
    const line = 'kochi-01/line-a';
    sitewise.setValue(line, 'line_max_vibration_5m', {
      timestampMs: NOW - 8 * 60_000,
      quality: 'GOOD',
      value: 3,
    });
    const latest = await telemetry.latest(sitewise.id(line));
    expect(latest.stale).toBe(false);
    expect(latest.staleAfterSeconds).toBe(660);
  });

  it('passes history pagination through and converts timestamps (FR-API-5)', async () => {
    const { sitewise, telemetry } = setup();
    sitewise.historyPage = {
      values: [{ timestampMs: NOW - 1000, quality: 'GOOD', value: 2.5 }],
      nextToken: 'next==',
    };
    const assetId = sitewise.id(pump);
    const propertyId = sitewise.propertyId(pump, 'vibration_mm_s');
    const result = await telemetry.history(assetId, propertyId, {
      from: '2026-10-09T11:00:00Z',
      to: '2026-10-09T12:00:00Z',
      limit: 100,
      nextToken: 'prev==',
    });
    expect(result).toEqual({
      assetId,
      propertyId,
      values: [{ timestamp: new Date(NOW - 1000).toISOString(), value: 2.5, quality: 'GOOD' }],
      nextToken: 'next==',
    });
    expect(sitewise.calls.history[0]).toMatchObject({ limit: 100, nextToken: 'prev==' });
  });

  it('returns aggregates for numeric properties and rejects string ones (FR-API-6)', async () => {
    const { sitewise, telemetry } = setup();
    sitewise.aggregateBuckets = [
      { timestampMs: NOW - 60_000, values: { AVERAGE: 60.1, MAXIMUM: 62 } },
    ];
    const query = {
      from: '2026-10-09T11:30:00Z',
      to: '2026-10-09T12:00:00Z',
      resolution: '1m' as const,
      types: ['AVERAGE' as const, 'MAXIMUM' as const],
    };
    const result = await telemetry.aggregates(
      sitewise.id(pump),
      sitewise.propertyId(pump, 'temperature_c'),
      query,
    );
    expect(result.points).toEqual([
      { timestamp: new Date(NOW - 60_000).toISOString(), values: { AVERAGE: 60.1, MAXIMUM: 62 } },
    ]);
    await expect(
      telemetry.aggregates(sitewise.id(pump), sitewise.propertyId(pump, 'status'), query),
    ).rejects.toMatchObject({ status: 400 });
  });
});
