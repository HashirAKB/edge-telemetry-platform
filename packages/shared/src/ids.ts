import { z } from 'zod';

/**
 * IDs appear in MQTT topics, SiteWise property aliases, and URLs, so they are restricted to
 * lowercase letters, digits, and single inner hyphens (SRS 4.1 allows `[a-z0-9-]`; leading,
 * trailing, and doubled hyphens are also rejected to keep aliases unambiguous).
 */
export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ID_MAX_LENGTH = 64;

export const Id = z
  .string()
  .max(ID_MAX_LENGTH)
  .regex(ID_PATTERN, 'must be lowercase letters, digits, and single inner hyphens');

/** Measurement names are snake_case (e.g. `temperature_c`). */
export const MEASUREMENT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export function assertId(value: string, label: string): void {
  if (!Id.safeParse(value).success) {
    throw new Error(`Invalid ${label} "${value}": ${ID_PATTERN.source}`);
  }
}
