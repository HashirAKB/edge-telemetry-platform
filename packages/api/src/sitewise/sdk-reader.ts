import {
  BatchGetAssetPropertyValueCommand,
  DescribeAssetCommand,
  DescribeAssetModelCommand,
  GetAssetPropertyAggregatesCommand,
  GetAssetPropertyValueHistoryCommand,
  ListAssociatedAssetsCommand,
  type AssetPropertyValue,
  type BatchGetAssetPropertyValueCommandOutput,
  type DescribeAssetCommandOutput,
  type DescribeAssetModelCommandOutput,
  type GetAssetPropertyAggregatesCommandOutput,
  type GetAssetPropertyValueHistoryCommandOutput,
  type ListAssociatedAssetsCommandOutput,
} from '@aws-sdk/client-iotsitewise';
import type { AggregateType, PropertyKind } from '@etp/shared';
import type {
  AggregateBucket,
  AggregatesRequest,
  AssetDescription,
  DataType,
  HistoryRequest,
  ModelDescription,
  PropertyRef,
  SiteWiseReader,
  Tqv,
} from './reader.js';

/** Documented limits (SiteWise API reference, checked 2026-10-09). */
export const BATCH_GET_MAX_ENTRIES = 128;
export const AGGREGATES_MAX_RESULTS = 2500;

/** The one method of IoTSiteWiseClient this module uses; tests pass a fake. */
export interface CommandSender {
  send(command: object): Promise<unknown>;
}

const AGGREGATE_FIELDS: Record<string, AggregateType> = {
  average: 'AVERAGE',
  count: 'COUNT',
  maximum: 'MAXIMUM',
  minimum: 'MINIMUM',
  standardDeviation: 'STANDARD_DEVIATION',
  sum: 'SUM',
};

export function toTqv(v: AssetPropertyValue): Tqv {
  const raw = v.value;
  const value =
    raw?.doubleValue ?? raw?.integerValue ?? raw?.booleanValue ?? raw?.stringValue ?? null;
  const seconds = v.timestamp?.timeInSeconds ?? 0;
  const nanos = v.timestamp?.offsetInNanos ?? 0;
  return {
    timestampMs: seconds * 1000 + Math.floor(nanos / 1e6),
    quality: v.quality ?? 'GOOD',
    value,
  };
}

function kindOf(
  type: { measurement?: unknown; transform?: unknown; metric?: unknown } | undefined,
): PropertyKind {
  if (type?.measurement) return 'measurement';
  if (type?.transform) return 'transform';
  if (type?.metric) return 'metric';
  return 'attribute';
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'ResourceNotFoundException';
}

/** SiteWiseReader backed by the AWS SDK v3. Owns chunking and pagination. */
export class SdkSiteWiseReader implements SiteWiseReader {
  constructor(private readonly client: CommandSender) {}

  private async send<T>(command: object): Promise<T> {
    return (await this.client.send(command)) as T;
  }

  async describeAsset(assetId: string): Promise<AssetDescription | null> {
    let out: DescribeAssetCommandOutput;
    try {
      out = await this.send(new DescribeAssetCommand({ assetId }));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    return {
      assetId: out.assetId ?? assetId,
      externalId: out.assetExternalId ?? null,
      name: out.assetName ?? '',
      modelId: out.assetModelId ?? '',
      properties: (out.assetProperties ?? []).map((p) => ({
        id: p.id ?? '',
        name: p.name ?? '',
        dataType: (p.dataType ?? 'STRING') as DataType,
        unit: p.unit ?? null,
        alias: p.alias ?? null,
      })),
      hierarchies: (out.assetHierarchies ?? []).map((h) => ({
        id: h.id ?? '',
        name: h.name ?? '',
      })),
    };
  }

  async listChildAssetIds(assetId: string, hierarchyId: string): Promise<string[]> {
    const ids: string[] = [];
    let nextToken: string | undefined;
    do {
      const out: ListAssociatedAssetsCommandOutput = await this.send(
        new ListAssociatedAssetsCommand({
          assetId,
          hierarchyId,
          traversalDirection: 'CHILD',
          maxResults: 250,
          nextToken,
        }),
      );
      for (const summary of out.assetSummaries ?? []) if (summary.id) ids.push(summary.id);
      nextToken = out.nextToken;
    } while (nextToken);
    return ids;
  }

  async describeModel(modelId: string): Promise<ModelDescription> {
    const out: DescribeAssetModelCommandOutput = await this.send(
      new DescribeAssetModelCommand({ assetModelId: modelId }),
    );
    return {
      modelId: out.assetModelId ?? modelId,
      externalId: out.assetModelExternalId ?? null,
      kinds: new Map((out.assetModelProperties ?? []).map((p) => [p.id ?? '', kindOf(p.type)])),
    };
  }

  async latestValues(entries: readonly PropertyRef[]): Promise<(Tqv | null)[]> {
    const results: (Tqv | null)[] = entries.map(() => null);
    for (let start = 0; start < entries.length; start += BATCH_GET_MAX_ENTRIES) {
      const chunk = entries.slice(start, start + BATCH_GET_MAX_ENTRIES).map((e, i) => ({
        entryId: `e${String(start + i)}`,
        assetId: e.assetId,
        propertyId: e.propertyId,
      }));
      let nextToken: string | undefined;
      do {
        const out: BatchGetAssetPropertyValueCommandOutput = await this.send(
          new BatchGetAssetPropertyValueCommand({ entries: chunk, nextToken }),
        );
        for (const success of out.successEntries ?? []) {
          const index = Number(success.entryId?.slice(1));
          if (success.assetPropertyValue && Number.isInteger(index)) {
            results[index] = toTqv(success.assetPropertyValue);
          }
        }
        nextToken = out.nextToken;
      } while (nextToken);
    }
    return results;
  }

  async history(q: HistoryRequest): Promise<{ values: Tqv[]; nextToken?: string }> {
    const out: GetAssetPropertyValueHistoryCommandOutput = await this.send(
      new GetAssetPropertyValueHistoryCommand({
        assetId: q.assetId,
        propertyId: q.propertyId,
        startDate: q.from,
        endDate: q.to,
        maxResults: q.limit,
        nextToken: q.nextToken,
        timeOrdering: 'ASCENDING',
      }),
    );
    const values = (out.assetPropertyValueHistory ?? []).map(toTqv);
    return out.nextToken ? { values, nextToken: out.nextToken } : { values };
  }

  async aggregates(q: AggregatesRequest): Promise<AggregateBucket[]> {
    const buckets: AggregateBucket[] = [];
    let nextToken: string | undefined;
    do {
      const out: GetAssetPropertyAggregatesCommandOutput = await this.send(
        new GetAssetPropertyAggregatesCommand({
          assetId: q.assetId,
          propertyId: q.propertyId,
          startDate: q.from,
          endDate: q.to,
          resolution: q.resolution,
          aggregateTypes: [...q.types],
          maxResults: AGGREGATES_MAX_RESULTS,
          timeOrdering: 'ASCENDING',
          nextToken,
        }),
      );
      for (const agg of out.aggregatedValues ?? []) {
        const values: Partial<Record<AggregateType, number>> = {};
        for (const [field, type] of Object.entries(AGGREGATE_FIELDS)) {
          const v = (agg.value as Record<string, number | undefined> | undefined)?.[field];
          if (v !== undefined && q.types.includes(type)) values[type] = v;
        }
        buckets.push({ timestampMs: agg.timestamp?.getTime() ?? 0, values });
      }
      nextToken = out.nextToken;
    } while (nextToken);
    return buckets;
  }
}
