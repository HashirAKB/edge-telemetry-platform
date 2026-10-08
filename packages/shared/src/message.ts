import { z } from 'zod';
import { Id } from './ids.js';
import {
  MACHINE_STATUSES,
  MACHINE_TYPES,
  NUMERIC_MEASUREMENTS,
  type MachineType,
  type NumericMeasurementName,
} from './measurements.js';
import { CONTRACT_VERSION } from './version.js';

/** Messages should stay under 1 KB (SRS 5.2). */
export const MESSAGE_SIZE_TARGET_BYTES = 1024;

/**
 * Lower bound for `ts` (2020-01-01T00:00:00Z in ms). Catches the classic bug of sending epoch
 * seconds instead of milliseconds, which would otherwise look like a date in 1970.
 */
export const MIN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);

/**
 * SiteWise accepts values timestamped up to 7 days in the past. For the future bound, AWS docs
 * disagree: the BatchPutAssetPropertyValue reference says 10 minutes, the IoT rule action page
 * says 5 (both checked 2026-10-09). Data arrives through the rule action, so the stricter
 * 5 minutes applies (ADR 0004). This bounds how long the edge can buffer.
 */
export const SITEWISE_MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000;
export const SITEWISE_MAX_FUTURE_MS = 5 * 60 * 1000;

export function isWithinSiteWiseWindow(tsMs: number, nowMs: number): boolean {
  return tsMs >= nowMs - SITEWISE_MAX_PAST_MS && tsMs <= nowMs + SITEWISE_MAX_FUTURE_MS;
}

function metricsSchemaFor<T extends MachineType>(type: T) {
  const shape = Object.fromEntries(
    NUMERIC_MEASUREMENTS[type].map((m) => [m.name, z.number()]),
  ) as Record<NumericMeasurementName<T>, z.ZodNumber>;
  // Strict: an unexpected metric is a contract error, not something to drop silently.
  return z.strictObject(shape);
}

function messageSchemaFor<T extends MachineType>(type: T) {
  return z.strictObject({
    v: z.literal(CONTRACT_VERSION),
    /** Device epoch milliseconds at sample time; used as the SiteWise timestamp. */
    ts: z.int().min(MIN_TIMESTAMP_MS),
    /** Monotonic per machine since process start; gaps reveal lost messages. */
    seq: z.int().nonnegative(),
    machineId: Id,
    metrics: metricsSchemaFor(type),
    status: z.enum(MACHINE_STATUSES),
  });
}

/** Per-type message schemas. The machine type comes from the topic, not the payload. */
export const TelemetryMessageV1ByType = {
  pump: messageSchemaFor('pump'),
  compressor: messageSchemaFor('compressor'),
} as const satisfies Record<MachineType, z.ZodType>;

/** Any valid v1 message (union over machine types). */
export const TelemetryMessageV1 = z.union(MACHINE_TYPES.map((t) => TelemetryMessageV1ByType[t]));

export type TelemetryMessageV1For<T extends MachineType> = z.infer<
  (typeof TelemetryMessageV1ByType)[T]
>;
export type TelemetryMessageV1 = z.infer<typeof TelemetryMessageV1>;

/** Validate a message for a known machine type, throwing a readable error. */
export function parseTelemetryMessage<T extends MachineType>(
  type: T,
  input: unknown,
): TelemetryMessageV1For<T> {
  const result = TelemetryMessageV1ByType[type].safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid ${type} telemetry message:\n${z.prettifyError(result.error)}`);
  }
  return result.data as TelemetryMessageV1For<T>;
}

export function messageSizeBytes(message: TelemetryMessageV1): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}
