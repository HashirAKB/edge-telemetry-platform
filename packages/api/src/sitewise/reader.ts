import type { AggregateResolution, AggregateType, PropertyKind, Quality } from '@etp/shared';

/**
 * Everything the API needs from SiteWise, in domain terms (FR-API-11). Services depend on this
 * interface only, so tests swap in an in-memory fake and never touch the AWS SDK.
 */
export interface SiteWiseReader {
  /** Accepts a UUID or `externalId:<id>`. Returns null when the asset does not exist. */
  describeAsset(assetId: string): Promise<AssetDescription | null>;
  listChildAssetIds(assetId: string, hierarchyId: string): Promise<string[]>;
  describeModel(modelId: string): Promise<ModelDescription>;
  /** Latest value per entry, in the same order as the input (null when there is none). */
  latestValues(entries: readonly PropertyRef[]): Promise<(Tqv | null)[]>;
  history(query: HistoryRequest): Promise<{ values: Tqv[]; nextToken?: string }>;
  aggregates(query: AggregatesRequest): Promise<AggregateBucket[]>;
}

export interface PropertyRef {
  readonly assetId: string;
  readonly propertyId: string;
}

export type DataType = 'DOUBLE' | 'INTEGER' | 'BOOLEAN' | 'STRING';

export interface RawProperty {
  readonly id: string;
  readonly name: string;
  readonly dataType: DataType;
  readonly unit: string | null;
  readonly alias: string | null;
}

export interface AssetDescription {
  readonly assetId: string;
  readonly externalId: string | null;
  readonly name: string;
  readonly modelId: string;
  readonly properties: readonly RawProperty[];
  readonly hierarchies: readonly { readonly id: string; readonly name: string }[];
}

export interface ModelDescription {
  readonly modelId: string;
  readonly externalId: string | null;
  /** Property kind by property ID (asset property IDs equal their model property IDs). */
  readonly kinds: ReadonlyMap<string, PropertyKind>;
}

/** Timestamp, quality, value. */
export interface Tqv {
  readonly timestampMs: number;
  readonly quality: Quality;
  readonly value: number | string | boolean | null;
}

export interface HistoryRequest extends PropertyRef {
  readonly from: Date;
  readonly to: Date;
  readonly limit: number;
  readonly nextToken?: string | undefined;
}

export interface AggregatesRequest extends PropertyRef {
  readonly from: Date;
  readonly to: Date;
  readonly resolution: AggregateResolution;
  readonly types: readonly AggregateType[];
}

export interface AggregateBucket {
  readonly timestampMs: number;
  readonly values: Partial<Record<AggregateType, number>>;
}
