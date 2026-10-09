import { assetExternalIdFor, listMachines, type MachineNode } from '@etp/shared';
import type { PropertyRef, SiteWiseReader } from '../sitewise/reader.js';

/** The measurement whose latest timestamp stands for "this machine is reporting" (FR-OBS-2). */
export const FRESHNESS_PROPERTY = 'temperature_c';

/**
 * Reported when a machine has never sent a value or its asset is missing: large enough to breach
 * any stale threshold, so a silent machine is never mistaken for a healthy one.
 */
export const NEVER_REPORTED_SECONDS = 7 * 24 * 3600;

export interface MachineFreshness {
  readonly machineId: string;
  readonly secondsSinceLastValue: number;
}

/**
 * Seconds since each machine's latest `temperature_c` value. Property IDs are resolved once
 * through the asset external IDs and cached for the life of the execution environment, so a
 * steady-state run is a single batch read.
 */
export class FreshnessMonitor {
  private refs: Map<string, PropertyRef | null> | undefined;

  constructor(
    private readonly reader: SiteWiseReader,
    private readonly machines: readonly MachineNode[] = listMachines(),
    private readonly now: () => number = Date.now,
  ) {}

  async measure(): Promise<MachineFreshness[]> {
    const refs = await this.resolve();
    const known = this.machines.filter((m) => refs.get(m.machineId));
    const values = await this.reader.latestValues(
      known.map((m) => refs.get(m.machineId) as PropertyRef),
    );
    const latest = new Map(known.map((m, i) => [m.machineId, values[i]?.timestampMs]));
    const now = this.now();
    return this.machines.map((m) => {
      const t = latest.get(m.machineId);
      return {
        machineId: m.machineId,
        secondsSinceLastValue:
          t === undefined ? NEVER_REPORTED_SECONDS : Math.max(0, Math.round((now - t) / 1000)),
      };
    });
  }

  private async resolve(): Promise<Map<string, PropertyRef | null>> {
    if (this.refs) return this.refs;
    const entries = await Promise.all(
      this.machines.map(async (m) => {
        const asset = await this.reader.describeAsset(
          `externalId:${assetExternalIdFor(m.siteId, m.lineId, m.machineId)}`,
        );
        const property = asset?.properties.find((p) => p.name === FRESHNESS_PROPERTY);
        const ref = asset && property ? { assetId: asset.assetId, propertyId: property.id } : null;
        return [m.machineId, ref] as const;
      }),
    );
    // Only cache a complete resolution; a missing asset is retried on the next run.
    const resolved = new Map(entries);
    if ([...resolved.values()].every(Boolean)) this.refs = resolved;
    return resolved;
  }
}
