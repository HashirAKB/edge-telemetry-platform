import { assertId, MEASUREMENT_NAME_PATTERN } from './ids.js';
import { measurementNamesFor } from './measurements.js';
import type { MachineNode } from './topology.js';

/**
 * SiteWise property alias for one machine measurement (SRS 4.4, ADR 0003):
 * `/{siteId}/{lineId}/{machineId}/{measurement}`. Devices and the IoT rule address
 * properties by alias, so nothing outside infra ever needs a SiteWise property ID.
 */
export function aliasFor(
  siteId: string,
  lineId: string,
  machineId: string,
  measurement: string,
): string {
  assertId(siteId, 'siteId');
  assertId(lineId, 'lineId');
  assertId(machineId, 'machineId');
  if (!MEASUREMENT_NAME_PATTERN.test(measurement)) {
    throw new Error(`Invalid measurement "${measurement}"`);
  }
  return `/${siteId}/${lineId}/${machineId}/${measurement}`;
}

export interface MeasurementAlias {
  readonly measurement: string;
  readonly alias: string;
}

/** Aliases for every measurement of a machine, including `status`. */
export function aliasesForMachine(machine: MachineNode): MeasurementAlias[] {
  return measurementNamesFor(machine.type).map((measurement) => ({
    measurement,
    alias: aliasFor(machine.siteId, machine.lineId, machine.machineId, measurement),
  }));
}
