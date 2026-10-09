import type { AssetPropertyValue } from '@aws-sdk/client-iotsitewise';
import { describe, expect, it } from 'vitest';
import {
  BATCH_GET_MAX_ENTRIES,
  SdkSiteWiseReader,
  toTqv,
  wholeSeconds,
  type CommandSender,
} from './sitewise/sdk-reader.js';

/** Fake SDK client: responds by command class name and records every input. */
function fakeClient(handlers: Record<string, (input: Record<string, unknown>) => unknown>) {
  const calls: { command: string; input: Record<string, unknown> }[] = [];
  const client: CommandSender = {
    send: (command) => {
      const name = command.constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      calls.push({ command: name, input });
      const handler = handlers[name];
      if (!handler) return Promise.reject(new Error(`unexpected ${name}`));
      try {
        return Promise.resolve(handler(input));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  return { client, calls };
}

const ts = (seconds: number) => ({ timeInSeconds: seconds, offsetInNanos: 250_000_000 });

describe('toTqv', () => {
  it('reads whichever value field is set and keeps millisecond precision', () => {
    expect(toTqv({ value: { doubleValue: 1.5 }, timestamp: ts(100), quality: 'GOOD' })).toEqual({
      value: 1.5,
      timestampMs: 100_250,
      quality: 'GOOD',
    });
    expect(toTqv({ value: { stringValue: 'FAULT' }, timestamp: ts(1) }).value).toBe('FAULT');
    expect(toTqv({ value: {}, timestamp: ts(1) })).toMatchObject({ value: null, quality: 'GOOD' });
  });
});

describe('SdkSiteWiseReader', () => {
  it('maps DescribeAsset and returns null for unknown assets', async () => {
    const notFound = Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' });
    const { client } = fakeClient({
      DescribeAssetCommand: (input) => {
        if (input.assetId === 'missing') throw notFound;
        return {
          assetId: 'a1',
          assetExternalId: 'kochi-01',
          assetName: 'kochi-01',
          assetModelId: 'm1',
          assetProperties: [{ id: 'p1', name: 'timezone', dataType: 'STRING' }],
          assetHierarchies: [{ id: 'h1', name: 'lines' }],
        };
      },
    });
    const reader = new SdkSiteWiseReader(client);
    await expect(reader.describeAsset('missing')).resolves.toBeNull();
    await expect(reader.describeAsset('a1')).resolves.toEqual({
      assetId: 'a1',
      externalId: 'kochi-01',
      name: 'kochi-01',
      modelId: 'm1',
      properties: [{ id: 'p1', name: 'timezone', dataType: 'STRING', unit: null, alias: null }],
      hierarchies: [{ id: 'h1', name: 'lines' }],
    });
  });

  it('rethrows errors other than not-found', async () => {
    const { client } = fakeClient({
      DescribeAssetCommand: () => {
        throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
      },
    });
    await expect(new SdkSiteWiseReader(client).describeAsset('a1')).rejects.toThrow('slow down');
  });

  it('labels model properties by kind', async () => {
    const { client } = fakeClient({
      DescribeAssetModelCommand: () => ({
        assetModelId: 'm1',
        assetModelExternalId: 'etp-pump',
        assetModelProperties: [
          { id: 'a', type: { measurement: {} } },
          { id: 'b', type: { transform: {} } },
          { id: 'c', type: { metric: {} } },
          { id: 'd', type: { attribute: {} } },
        ],
      }),
    });
    const model = await new SdkSiteWiseReader(client).describeModel('m1');
    expect(model.externalId).toBe('etp-pump');
    expect([...model.kinds.values()]).toEqual(['measurement', 'transform', 'metric', 'attribute']);
  });

  it('follows pagination when listing children', async () => {
    const { client, calls } = fakeClient({
      ListAssociatedAssetsCommand: (input) =>
        input.nextToken
          ? { assetSummaries: [{ id: 'c3' }] }
          : { assetSummaries: [{ id: 'c1' }, { id: 'c2' }], nextToken: 't' },
    });
    await expect(new SdkSiteWiseReader(client).listChildAssetIds('p', 'h')).resolves.toEqual([
      'c1',
      'c2',
      'c3',
    ]);
    expect(calls[0]?.input).toMatchObject({ traversalDirection: 'CHILD', hierarchyId: 'h' });
  });

  it('chunks latest-value requests at 128 entries and keeps input order (FR-API-4)', async () => {
    const { client, calls } = fakeClient({
      BatchGetAssetPropertyValueCommand: (input) => {
        const entries = input.entries as { entryId: string }[];
        return {
          successEntries: entries
            .filter((e) => e.entryId !== 'e5')
            .map((e) => ({
              entryId: e.entryId,
              assetPropertyValue: {
                value: { doubleValue: Number(e.entryId.slice(1)) },
                timestamp: ts(1),
              },
            })),
        };
      },
    });
    const refs = Array.from({ length: 300 }, (_, i) => ({
      assetId: 'a',
      propertyId: `p${String(i)}`,
    }));
    const values = await new SdkSiteWiseReader(client).latestValues(refs);
    expect(calls.map((c) => (c.input.entries as unknown[]).length)).toEqual([
      BATCH_GET_MAX_ENTRIES,
      BATCH_GET_MAX_ENTRIES,
      44,
    ]);
    expect(values[0]?.value).toBe(0);
    expect(values[299]?.value).toBe(299);
    expect(values[5]).toBeNull();
  });

  it('follows nextToken within a latest-value chunk', async () => {
    const { client, calls } = fakeClient({
      BatchGetAssetPropertyValueCommand: (input) =>
        input.nextToken
          ? {
              successEntries: [
                {
                  entryId: 'e1',
                  assetPropertyValue: { value: { doubleValue: 2 }, timestamp: ts(1) },
                },
              ],
            }
          : {
              successEntries: [
                {
                  entryId: 'e0',
                  assetPropertyValue: { value: { doubleValue: 1 }, timestamp: ts(1) },
                },
              ],
              nextToken: 'more',
            },
    });
    const values = await new SdkSiteWiseReader(client).latestValues([
      { assetId: 'a', propertyId: 'x' },
      { assetId: 'a', propertyId: 'y' },
    ]);
    expect(values.map((v) => v?.value)).toEqual([1, 2]);
    expect(calls).toHaveLength(2);
  });

  it('passes history paging and dates straight through (FR-API-5)', async () => {
    const { client, calls } = fakeClient({
      GetAssetPropertyValueHistoryCommand: () => ({
        assetPropertyValueHistory: [{ value: { doubleValue: 3 }, timestamp: ts(5) }],
        nextToken: 'n2',
      }),
    });
    const from = new Date('2026-10-09T00:00:00Z');
    const to = new Date('2026-10-09T01:00:00Z');
    const page = await new SdkSiteWiseReader(client).history({
      assetId: 'a',
      propertyId: 'p',
      from,
      to,
      limit: 10,
      nextToken: 'n1',
    });
    expect(page).toEqual({
      values: [{ value: 3, timestampMs: 5_250, quality: 'GOOD' }],
      nextToken: 'n2',
    });
    expect(calls[0]?.input).toMatchObject({
      startDate: from,
      endDate: to,
      maxResults: 10,
      nextToken: 'n1',
    });
  });

  it('collects every aggregate page and maps value fields to API types (FR-API-6)', async () => {
    const { client, calls } = fakeClient({
      GetAssetPropertyAggregatesCommand: (input) =>
        input.nextToken
          ? {
              aggregatedValues: [
                { timestamp: new Date(120_000), value: { average: 2, maximum: 9 } },
              ],
            }
          : {
              aggregatedValues: [
                { timestamp: new Date(60_000), value: { average: 1, standardDeviation: 0.5 } },
              ],
              nextToken: 'p2',
            },
    });
    const buckets = await new SdkSiteWiseReader(client).aggregates({
      assetId: 'a',
      propertyId: 'p',
      from: new Date(0),
      to: new Date(180_000),
      resolution: '1m',
      types: ['AVERAGE', 'STANDARD_DEVIATION'],
    });
    expect(buckets).toEqual([
      { timestampMs: 60_000, values: { AVERAGE: 1, STANDARD_DEVIATION: 0.5 } },
      { timestampMs: 120_000, values: { AVERAGE: 2 } },
    ]);
    expect(calls[0]?.input).toMatchObject({ resolution: '1m', maxResults: 2500 });
  });

  it('tolerates sparse responses: missing optional fields and empty pages', async () => {
    const { client } = fakeClient({
      DescribeAssetCommand: () => ({ assetProperties: [{}], assetHierarchies: [{}] }),
      DescribeAssetModelCommand: () => ({}),
      ListAssociatedAssetsCommand: () => ({ assetSummaries: [{}] }),
      BatchGetAssetPropertyValueCommand: () => ({
        successEntries: [{ entryId: 'e0' }, { entryId: 'x' }],
      }),
      GetAssetPropertyValueHistoryCommand: () => ({}),
      GetAssetPropertyAggregatesCommand: () => ({ aggregatedValues: [{}] }),
    });
    const reader = new SdkSiteWiseReader(client);
    await expect(reader.describeAsset('a9')).resolves.toEqual({
      assetId: 'a9',
      externalId: null,
      name: '',
      modelId: '',
      properties: [{ id: '', name: '', dataType: 'STRING', unit: null, alias: null }],
      hierarchies: [{ id: '', name: '' }],
    });
    const model = await reader.describeModel('m9');
    expect(model).toMatchObject({ modelId: 'm9', externalId: null });
    expect(model.kinds.size).toBe(0);
    await expect(reader.listChildAssetIds('a', 'h')).resolves.toEqual([]);
    await expect(reader.latestValues([{ assetId: 'a', propertyId: 'p' }])).resolves.toEqual([null]);
    const window = { assetId: 'a', propertyId: 'p', from: new Date(0), to: new Date(1) };
    await expect(reader.history({ ...window, limit: 1 })).resolves.toEqual({ values: [] });
    await expect(
      reader.aggregates({ ...window, resolution: '1h', types: ['AVERAGE'] }),
    ).resolves.toEqual([{ timestampMs: 0, values: {} }]);
    // The SDK types mark these fields required; this guards against a malformed response anyway.
    expect(toTqv({} as AssetPropertyValue)).toEqual({
      value: null,
      timestampMs: 0,
      quality: 'GOOD',
    });
  });

  it('sends whole-second dates, widening the range outward (SiteWise rejects milliseconds)', async () => {
    const { client, calls } = fakeClient({
      GetAssetPropertyValueHistoryCommand: () => ({}),
      GetAssetPropertyAggregatesCommand: () => ({}),
    });
    const reader = new SdkSiteWiseReader(client);
    const window = {
      assetId: 'a',
      propertyId: 'p',
      from: new Date('2026-10-09T05:14:45.219Z'),
      to: new Date('2026-10-09T05:44:45.219Z'),
    };
    await reader.history({ ...window, limit: 10 });
    await reader.aggregates({ ...window, resolution: '1m', types: ['AVERAGE'] });
    for (const call of calls) {
      expect(call.input.startDate).toEqual(new Date('2026-10-09T05:14:45.000Z'));
      expect(call.input.endDate).toEqual(new Date('2026-10-09T05:44:46.000Z'));
    }
    expect(wholeSeconds({ from: new Date(3000), to: new Date(5000) })).toEqual({
      startDate: new Date(3000),
      endDate: new Date(5000),
    });
  });
});
