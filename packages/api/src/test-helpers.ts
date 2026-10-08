import {
  assetExternalIdFor,
  externalKeyFor,
  SITEWISE_MODELS,
  topology,
  type ModelType,
} from '@etp/shared';
import type { AppLogger, AppMetrics } from './http/app.js';
import type {
  AggregateBucket,
  AssetDescription,
  HistoryRequest,
  ModelDescription,
  PropertyRef,
  SiteWiseReader,
  Tqv,
} from './sitewise/reader.js';

let counter = 0;
/** Deterministic, schema-valid UUIDs for fixtures. */
export function uuid(): string {
  counter += 1;
  return `aaaaaaaa-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
}

/**
 * In-memory SiteWise holding the real topology and models: 8 assets, 4 models, every property
 * with an ID. Values are set per property; calls are counted for cache tests.
 */
export class FakeSiteWise implements SiteWiseReader {
  readonly assets = new Map<string, AssetDescription>();
  readonly models = new Map<string, ModelDescription>();
  readonly children = new Map<string, string[]>(); // `${assetId}/${hierarchyId}` -> ids
  readonly values = new Map<string, Tqv>(); // `${assetId}/${propertyId}` -> latest
  readonly calls = { describeAsset: 0, latestValues: 0, history: [] as HistoryRequest[] };
  historyPage: { values: Tqv[]; nextToken?: string } = { values: [] };
  aggregateBuckets: AggregateBucket[] = [];
  failNext: Error | undefined;
  readonly ids: Record<string, string> = {}; // topology key -> asset ID

  constructor() {
    const modelIds = {} as Record<ModelType, string>;
    const propertyIds = {} as Record<ModelType, Map<string, string>>;
    const hierarchyIds = {} as Record<ModelType, Map<string, string>>;
    for (const spec of Object.values(SITEWISE_MODELS)) {
      const modelId = uuid();
      modelIds[spec.type] = modelId;
      propertyIds[spec.type] = new Map(spec.properties.map((p) => [p.name, uuid()]));
      hierarchyIds[spec.type] = new Map(spec.hierarchies.map((h) => [h.name, uuid()]));
      this.models.set(modelId, {
        modelId,
        externalId: spec.name,
        kinds: new Map(
          spec.properties.map((p) => [propertyIds[spec.type].get(p.name) ?? '', p.kind]),
        ),
      });
    }

    const addAsset = (type: ModelType, ids: string[], children: Record<string, string[]>) => {
      const assetId = uuid();
      const spec = SITEWISE_MODELS[type];
      this.assets.set(assetId, {
        assetId,
        externalId: assetExternalIdFor(...ids),
        name: externalKeyFor(...ids),
        modelId: modelIds[type],
        properties: spec.properties.map((p) => ({
          id: propertyIds[type].get(p.name) ?? '',
          name: p.name,
          dataType: p.dataType,
          unit: p.unit ?? null,
          alias: p.kind === 'measurement' ? `/${ids.join('/')}/${p.name}` : null,
        })),
        hierarchies: spec.hierarchies.map((h) => ({
          id: hierarchyIds[type].get(h.name) ?? '',
          name: h.name,
        })),
      });
      for (const [hierarchy, childIds] of Object.entries(children)) {
        this.children.set(`${assetId}/${hierarchyIds[type].get(hierarchy) ?? ''}`, childIds);
      }
      this.ids[externalKeyFor(...ids)] = assetId;
      return assetId;
    };

    const site = topology.site.id;
    const lineIds = topology.lines.map((line) => {
      const pumps: string[] = [];
      const compressors: string[] = [];
      for (const m of line.machines) {
        const id = addAsset(m.type, [site, line.id, m.id], {});
        (m.type === 'pump' ? pumps : compressors).push(id);
      }
      return addAsset('line', [site, line.id], { pumps, compressors });
    });
    addAsset('site', [site], { lines: lineIds });
  }

  id(key: string): string {
    const id = this.ids[key];
    if (!id) throw new Error(`no fixture asset ${key}`);
    return id;
  }

  propertyId(key: string, name: string): string {
    const p = this.assets.get(this.id(key))?.properties.find((q) => q.name === name);
    if (!p) throw new Error(`no property ${name} on ${key}`);
    return p.id;
  }

  setValue(key: string, name: string, tqv: Tqv): void {
    this.values.set(`${this.id(key)}/${this.propertyId(key, name)}`, tqv);
  }

  private maybeFail(): void {
    const error = this.failNext;
    this.failNext = undefined;
    if (error) throw error;
  }

  describeAsset(assetId: string): Promise<AssetDescription | null> {
    this.calls.describeAsset += 1;
    this.maybeFail();
    const id = assetId.startsWith('externalId:')
      ? [...this.assets.values()].find((a) => `externalId:${a.externalId ?? ''}` === assetId)
          ?.assetId
      : assetId;
    return Promise.resolve((id && this.assets.get(id)) || null);
  }

  listChildAssetIds(assetId: string, hierarchyId: string): Promise<string[]> {
    return Promise.resolve(this.children.get(`${assetId}/${hierarchyId}`) ?? []);
  }

  describeModel(modelId: string): Promise<ModelDescription> {
    const model = this.models.get(modelId);
    if (!model) throw new Error(`no model ${modelId}`);
    return Promise.resolve(model);
  }

  latestValues(entries: readonly PropertyRef[]): Promise<(Tqv | null)[]> {
    this.calls.latestValues += 1;
    this.maybeFail();
    return Promise.resolve(
      entries.map((e) => this.values.get(`${e.assetId}/${e.propertyId}`) ?? null),
    );
  }

  history(query: HistoryRequest): Promise<{ values: Tqv[]; nextToken?: string }> {
    this.calls.history.push(query);
    return Promise.resolve(this.historyPage);
  }

  aggregates(): Promise<AggregateBucket[]> {
    return Promise.resolve(this.aggregateBuckets);
  }
}

export function fakeObservability() {
  const logs: { level: string; message: string; extra?: Record<string, unknown> }[] = [];
  const metrics: { name: string; value: number; dimensions: Record<string, string> }[] = [];
  let dimensions: Record<string, string> = {};
  const logger: AppLogger = {
    addContext: () => undefined,
    appendKeys: () => undefined,
    resetKeys: () => undefined,
    info: (message, extra) => logs.push({ level: 'info', message, ...(extra ? { extra } : {}) }),
    warn: (message, extra) => logs.push({ level: 'warn', message, ...(extra ? { extra } : {}) }),
    error: (message, extra) => logs.push({ level: 'error', message, ...(extra ? { extra } : {}) }),
  };
  const appMetrics: AppMetrics = {
    addDimension: (name, value) => {
      dimensions[name] = value;
    },
    addMetric: (name, _unit, value) => {
      metrics.push({ name, value, dimensions: { ...dimensions } });
    },
    publishStoredMetrics: () => {
      dimensions = {};
    },
  };
  return { logger, metrics: appMetrics, logs, recorded: metrics };
}
