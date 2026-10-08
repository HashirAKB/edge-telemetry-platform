import {
  externalKeyFor,
  SITEWISE_MODELS,
  type AssetDetail,
  type AssetProperty,
  type AssetTreeNode,
  type AssetTreeResponse,
  type ModelType,
} from '@etp/shared';
import { notFound } from '../http/errors.js';
import type { AssetDescription, ModelDescription, SiteWiseReader } from '../sitewise/reader.js';

/** FR-API-1: the tree is cached in Lambda memory for 5 minutes. */
export const TREE_TTL_MS = 5 * 60_000;

const MODEL_TYPE_BY_NAME = new Map<string, ModelType>(
  Object.values(SITEWISE_MODELS).map((m) => [m.name, m.type]),
);

interface IndexedNode {
  readonly node: AssetTreeNode;
  readonly parentAssetId: string | null;
}

interface Snapshot {
  readonly tree: AssetTreeResponse;
  readonly byId: ReadonlyMap<string, IndexedNode>;
  readonly byKey: ReadonlyMap<string, IndexedNode>;
}

export interface CatalogOptions {
  /** External ID of the site asset, e.g. `kochi-01`. */
  readonly rootExternalId: string;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * The site's asset hierarchy, read from SiteWise and indexed by asset ID and topology key.
 * Every API lookup goes through it, so the API can only ever reach assets in this site.
 */
export class CatalogService {
  private cached: { snapshot: Promise<Snapshot>; expiresAt: number } | undefined;
  private readonly now: () => number;

  constructor(
    private readonly reader: SiteWiseReader,
    private readonly options: CatalogOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async tree(): Promise<AssetTreeResponse> {
    return (await this.snapshot()).tree;
  }

  async asset(assetId: string): Promise<AssetDetail> {
    const found = (await this.snapshot()).byId.get(assetId);
    if (!found) throw notFound(`Asset ${assetId} is not part of this site`);
    return toDetail(found);
  }

  async assetByKey(...ids: string[]): Promise<AssetDetail> {
    const key = externalKeyFor(...ids);
    const found = (await this.snapshot()).byKey.get(key);
    if (!found) throw notFound(`No asset with key ${key}`);
    return toDetail(found);
  }

  /** The tree node for an asset, or 404. Used by the telemetry service. */
  async node(assetId: string): Promise<AssetTreeNode> {
    const found = (await this.snapshot()).byId.get(assetId);
    if (!found) throw notFound(`Asset ${assetId} is not part of this site`);
    return found.node;
  }

  async property(assetId: string, propertyId: string): Promise<AssetProperty> {
    const node = await this.node(assetId);
    const property = node.properties.find((p) => p.propertyId === propertyId);
    if (!property) throw notFound(`Property ${propertyId} is not on asset ${assetId}`);
    return property;
  }

  /** Cheap reachability probe for the health check (FR-API-7). */
  async reachable(): Promise<boolean> {
    try {
      return (
        (await this.reader.describeAsset(`externalId:${this.options.rootExternalId}`)) !== null
      );
    } catch {
      return false;
    }
  }

  private snapshot(): Promise<Snapshot> {
    const now = this.now();
    if (this.cached && now < this.cached.expiresAt) return this.cached.snapshot;
    // Share one in-flight build between concurrent requests; never cache a failure.
    const snapshot = this.build().catch((error: unknown) => {
      this.cached = undefined;
      throw error;
    });
    this.cached = { snapshot, expiresAt: now + (this.options.ttlMs ?? TREE_TTL_MS) };
    return snapshot;
  }

  private async build(): Promise<Snapshot> {
    const models = new Map<string, Promise<ModelDescription>>();
    const model = (id: string): Promise<ModelDescription> => {
      let found = models.get(id);
      if (!found) {
        found = this.reader.describeModel(id);
        models.set(id, found);
      }
      return found;
    };

    const byId = new Map<string, IndexedNode>();
    const byKey = new Map<string, IndexedNode>();

    const visit = async (assetId: string, parentAssetId: string | null): Promise<AssetTreeNode> => {
      const asset = await this.reader.describeAsset(assetId);
      if (!asset) throw new Error(`Asset ${assetId} disappeared while building the tree`);
      const description = await model(asset.modelId);
      const childIds = (
        await Promise.all(
          asset.hierarchies.map((h) => this.reader.listChildAssetIds(asset.assetId, h.id)),
        )
      ).flat();
      const children = await Promise.all(childIds.map((id) => visit(id, asset.assetId)));
      const node = toNode(asset, description, children);
      const indexed = { node, parentAssetId };
      byId.set(node.assetId, indexed);
      byKey.set(node.externalKey, indexed);
      return node;
    };

    const site = await visit(`externalId:${this.options.rootExternalId}`, null);
    return {
      tree: { site, generatedAt: new Date(this.now()).toISOString() },
      byId,
      byKey,
    };
  }
}

function toNode(
  asset: AssetDescription,
  model: ModelDescription,
  children: AssetTreeNode[],
): AssetTreeNode {
  const type = MODEL_TYPE_BY_NAME.get(model.externalId ?? '');
  if (!type) throw new Error(`Asset ${asset.assetId} uses unknown model ${model.modelId}`);
  return {
    assetId: asset.assetId,
    // External IDs join topology IDs with dots; the API key joins them with slashes.
    externalKey: (asset.externalId ?? asset.name).split('.').join('/'),
    name: asset.name,
    type,
    properties: asset.properties.map((p) => ({
      propertyId: p.id,
      name: p.name,
      kind: model.kinds.get(p.id) ?? 'attribute',
      unit: p.unit,
      dataType: p.dataType,
      alias: p.alias,
    })),
    children,
  };
}

function toDetail({ node, parentAssetId }: IndexedNode): AssetDetail {
  return {
    assetId: node.assetId,
    externalKey: node.externalKey,
    name: node.name,
    type: node.type,
    properties: node.properties,
    parentAssetId,
    childAssetIds: node.children.map((c) => c.assetId),
  };
}
