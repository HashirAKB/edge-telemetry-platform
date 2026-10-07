import { z } from 'zod';
import { Id } from '../ids.js';
import { AssetId, PropertyId } from './common.js';

export const AssetType = z.enum(['site', 'line', 'pump', 'compressor']);
export type AssetType = z.infer<typeof AssetType>;

export const PropertyKind = z.enum(['measurement', 'transform', 'metric', 'attribute']);
export type PropertyKind = z.infer<typeof PropertyKind>;

export const PropertyDataType = z.enum(['DOUBLE', 'INTEGER', 'BOOLEAN', 'STRING']);

export const AssetProperty = z
  .object({
    propertyId: PropertyId,
    name: z.string(),
    kind: PropertyKind,
    unit: z.string().nullable(),
    dataType: PropertyDataType,
    /** Set on measurements only; e.g. `/kochi-01/line-a/pump-01/temperature_c`. */
    alias: z.string().nullable(),
  })
  .meta({ id: 'AssetProperty' });
export type AssetProperty = z.infer<typeof AssetProperty>;

const assetFields = {
  assetId: AssetId,
  /** Topology key, e.g. `kochi-01/line-a/pump-01`, so apps can use human-readable IDs. */
  externalKey: z.string(),
  name: z.string(),
  type: AssetType,
  properties: z.array(AssetProperty),
};

export interface AssetTreeNode {
  assetId: string;
  externalKey: string;
  name: string;
  type: AssetType;
  properties: AssetProperty[];
  children: AssetTreeNode[];
}

/** One node of the hierarchy: site, then lines, then machines (FR-API-1). */
export const AssetTreeNode: z.ZodType<AssetTreeNode> = z
  .object({
    ...assetFields,
    get children() {
      return z.array(AssetTreeNode);
    },
  })
  .meta({ id: 'AssetTreeNode' });

export const AssetTreeResponse = z
  .object({ site: AssetTreeNode, generatedAt: z.iso.datetime({ offset: true }) })
  .meta({ id: 'AssetTreeResponse' });
export type AssetTreeResponse = z.infer<typeof AssetTreeResponse>;

/** One asset with its properties and direct relations (FR-API-2, FR-API-3). */
export const AssetDetail = z
  .object({
    ...assetFields,
    parentAssetId: AssetId.nullable(),
    childAssetIds: z.array(AssetId),
  })
  .meta({ id: 'AssetDetail' });
export type AssetDetail = z.infer<typeof AssetDetail>;

export const AssetIdParams = z.object({ assetId: AssetId });

export const AssetByKeyParams = z.object({ siteId: Id, lineId: Id, machineId: Id });
export type AssetByKeyParams = z.infer<typeof AssetByKeyParams>;

export function externalKeyFor(...ids: string[]): string {
  return ids.join('/');
}
