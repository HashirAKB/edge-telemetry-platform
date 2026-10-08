import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as sitewise from 'aws-cdk-lib/aws-iotsitewise';
import type { Construct } from 'constructs';
import {
  aliasFor,
  assetExternalIdFor,
  externalKeyFor,
  measurementNamesFor,
  MODEL_CREATION_ORDER,
  SITEWISE_MODELS,
  topology as defaultTopology,
  type MachineType,
  type ModelType,
  type PropertySpec,
  type Topology,
  type VariableRef,
} from '@etp/shared';

export interface SiteWiseStackProps extends StackProps {
  /** Defaults to the shared topology; tests pass a modified one (FR-SW-3). */
  readonly topology?: Topology;
}

/**
 * Asset models and one asset per topology node (FR-SW-1, FR-SW-2). Models, properties, and
 * hierarchies are addressed by logical ID, so nothing here hard-codes a SiteWise UUID.
 */
export class SiteWiseStack extends Stack {
  readonly rootAssetId: string;
  /** Assets that receive telemetry (one per machine); the only ones the ingest rule writes to. */
  readonly machineAssetIds: string[] = [];
  readonly models: Readonly<Record<ModelType, sitewise.CfnAssetModel>>;

  constructor(scope: Construct, id: string, props: SiteWiseStackProps = {}) {
    super(scope, id, props);
    const plant = props.topology ?? defaultTopology;

    const models: Partial<Record<ModelType, sitewise.CfnAssetModel>> = {};
    for (const type of MODEL_CREATION_ORDER) {
      const spec = SITEWISE_MODELS[type];
      models[type] = new sitewise.CfnAssetModel(this, `Model-${type}`, {
        assetModelName: spec.name,
        assetModelExternalId: spec.name,
        assetModelDescription: spec.description,
        assetModelProperties: spec.properties.map(toCfnProperty),
        assetModelHierarchies: spec.hierarchies.map((h) => ({
          name: h.name,
          logicalId: h.name,
          childAssetModelId: requireModel(models, h.childModel).attrAssetModelId,
        })),
      });
    }
    this.models = models as Record<ModelType, sitewise.CfnAssetModel>;

    const siteId = plant.site.id;
    const lineAssets = plant.lines.map((line) => {
      const machineAssets = line.machines.map((machine) => {
        const asset = new sitewise.CfnAsset(this, `Asset-${line.id}-${machine.id}`, {
          assetModelId: this.models[machine.type].attrAssetModelId,
          assetName: externalKeyFor(siteId, line.id, machine.id),
          assetExternalId: assetExternalIdFor(siteId, line.id, machine.id),
          assetDescription: `${machine.type} ${machine.id} on ${line.name}`,
          // Measurements get the alias the IoT rule writes to (ADR 0003). MQTT notifications
          // stay off: nothing subscribes to them in this build (FR-SW-4).
          assetProperties: measurementNamesFor(machine.type).map((measurement) => ({
            logicalId: measurement,
            alias: aliasFor(siteId, line.id, machine.id, measurement),
            notificationState: 'DISABLED',
          })),
        });
        this.machineAssetIds.push(asset.attrAssetId);
        return { asset, type: machine.type };
      });

      return new sitewise.CfnAsset(this, `Asset-${line.id}`, {
        assetModelId: this.models.line.attrAssetModelId,
        assetName: externalKeyFor(siteId, line.id),
        assetExternalId: assetExternalIdFor(siteId, line.id),
        assetDescription: line.name,
        assetHierarchies: machineAssets.map(({ asset, type }) => ({
          logicalId: hierarchyFor(type),
          childAssetId: asset.attrAssetId,
        })),
      });
    });

    const site = new sitewise.CfnAsset(this, 'Asset-site', {
      assetModelId: this.models.site.attrAssetModelId,
      assetName: siteId,
      assetExternalId: assetExternalIdFor(siteId),
      assetDescription: plant.site.name,
      assetHierarchies: lineAssets.map((asset) => ({
        logicalId: 'lines',
        childAssetId: asset.attrAssetId,
      })),
    });
    this.rootAssetId = site.attrAssetId;

    new CfnOutput(this, 'RootAssetId', {
      value: site.attrAssetId,
      description: 'SiteWise asset ID of the site (root of the hierarchy)',
    });
  }
}

function requireModel(
  models: Partial<Record<ModelType, sitewise.CfnAssetModel>>,
  type: ModelType,
): sitewise.CfnAssetModel {
  const model = models[type];
  if (!model) throw new Error(`model ${type} must be created before its parents`);
  return model;
}

/** The line-model hierarchy that holds machines of this type ("pumps", "compressors"). */
export function hierarchyFor(type: MachineType): string {
  const hierarchy = SITEWISE_MODELS.line.hierarchies.find((h) => h.childModel === type);
  if (!hierarchy) throw new Error(`line model has no hierarchy for ${type}`);
  return hierarchy.name;
}

function toVariables(variables: Readonly<Record<string, VariableRef>>) {
  return Object.entries(variables).map(([name, ref]) => ({
    name,
    value: {
      propertyLogicalId: ref.property,
      ...(ref.hierarchy ? { hierarchyLogicalId: ref.hierarchy } : {}),
    },
  }));
}

export function toCfnProperty(
  spec: PropertySpec,
): sitewise.CfnAssetModel.AssetModelPropertyProperty {
  const base = {
    name: spec.name,
    logicalId: spec.name,
    dataType: spec.dataType,
    ...(spec.unit ? { unit: spec.unit } : {}),
  };
  switch (spec.kind) {
    case 'measurement':
      return { ...base, type: { typeName: 'Measurement' } };
    case 'attribute':
      return {
        ...base,
        type: { typeName: 'Attribute', attribute: { defaultValue: spec.defaultValue } },
      };
    case 'transform':
      return {
        ...base,
        type: {
          typeName: 'Transform',
          transform: { expression: spec.expression, variables: toVariables(spec.variables) },
        },
      };
    case 'metric':
      return {
        ...base,
        type: {
          typeName: 'Metric',
          metric: {
            expression: spec.expression,
            variables: toVariables(spec.variables),
            window: { tumbling: { interval: spec.window } },
          },
        },
      };
  }
}
