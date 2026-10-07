import { MEASUREMENT_NAME_PATTERN } from './ids.js';
import { CONTRACT_VERSION } from './version.js';
import type { MachineType } from './measurements.js';
import type { MachineNode } from './topology.js';

/**
 * MQTT topic contract (SRS 5.1): `telemetry/v1/{siteId}/{lineId}/{machineType}/{machineId}`.
 * The version segment lets a future v2 rule run alongside v1 (SRS 5.3).
 */
export const TOPIC_ROOT = 'telemetry';
export const TOPIC_VERSION = `v${CONTRACT_VERSION}`;
export const TOPIC_PREFIX = `${TOPIC_ROOT}/${TOPIC_VERSION}`;

/** Filter for everything a device may publish; used by the IPC and IoT policies. */
export const PUBLISH_TOPIC_FILTER = `${TOPIC_PREFIX}/#`;

/** 1-based segment positions, as used by the IoT SQL `topic(n)` function. */
export const TOPIC_SEGMENT = {
  root: 1,
  version: 2,
  site: 3,
  line: 4,
  machineType: 5,
  machine: 6,
} as const;

export function topicFor(machine: MachineNode): string {
  return `${TOPIC_PREFIX}/${machine.siteId}/${machine.lineId}/${machine.type}/${machine.machineId}`;
}

/** Topic filter matching every machine of one type, at any site and line. */
export function topicFilterForType(type: MachineType): string {
  return `${TOPIC_PREFIX}/+/+/${type}/+`;
}

/** IoT topic rule SQL for one machine type (SQL version 2016-03-23). */
export function ruleSqlForType(type: MachineType): string {
  return `SELECT * FROM '${topicFilterForType(type)}'`;
}

/**
 * Property alias as an IoT rule substitution template. It must produce exactly what
 * `aliasFor()` produces for the publishing machine; a unit test enforces that.
 */
export function ruleAliasTemplate(measurement: string): string {
  if (!MEASUREMENT_NAME_PATTERN.test(measurement)) {
    throw new Error(`Invalid measurement "${measurement}"`);
  }
  const t = (n: number): string => `\${topic(${n})}`;
  return `/${t(TOPIC_SEGMENT.site)}/${t(TOPIC_SEGMENT.line)}/${t(TOPIC_SEGMENT.machine)}/${measurement}`;
}
