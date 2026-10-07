import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  DEFAULT_PUBLISH_INTERVAL_MS,
  Id,
  listMachines,
  MACHINE_TYPES,
  measurementNamesFor,
  STATUS_MEASUREMENT,
} from '@etp/shared';
import { FaultSpec } from './faults.js';

const Device = z.strictObject({
  siteId: Id,
  lineId: Id,
  machineId: Id,
  type: z.enum(MACHINE_TYPES),
});

const IdleWindow = z.strictObject({
  machineId: Id,
  startOffsetSec: z.number().nonnegative(),
  durationSec: z.number().positive(),
});

export const TRANSPORTS = ['stdout', 'mqtt'] as const;

export const SimulatorConfigSchema = z
  .strictObject({
    /** Same seed, same series (FR-SIM-2). */
    seed: z.int().default(42),
    intervalMs: z.int().min(100).max(3_600_000).default(DEFAULT_PUBLISH_INTERVAL_MS),
    /** Defaults to every machine in the shared topology (ADR 0001). */
    devices: z.array(Device).min(1).default(listMachines),
    faults: z.array(FaultSpec).default([]),
    idleWindows: z.array(IdleWindow).default([]),
    /** In-memory buffer for local publish failures; ~80 min of default traffic. */
    bufferMax: z.int().min(1).max(1_000_000).default(5_000),
    transport: z.enum(TRANSPORTS).default('stdout'),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    mqtt: z
      .strictObject({
        endpoint: z.string().min(1),
        certPath: z.string().min(1),
        keyPath: z.string().min(1),
        clientId: z.string().min(1).max(128),
        caPath: z.string().min(1).optional(),
      })
      .optional(),
  })
  .superRefine((config, ctx) => {
    const types = new Map<string, (typeof MACHINE_TYPES)[number]>();
    config.devices.forEach((device, i) => {
      if (types.has(device.machineId)) {
        ctx.addIssue({ code: 'custom', path: ['devices', i], message: 'duplicate machineId' });
      }
      types.set(device.machineId, device.type);
    });

    const checkMachine = (machineId: string, path: (string | number)[]): void => {
      if (!types.has(machineId)) {
        ctx.addIssue({ code: 'custom', path, message: `unknown machineId "${machineId}"` });
      }
    };
    config.faults.forEach((fault, i) => {
      checkMachine(fault.machineId, ['faults', i, 'machineId']);
      const type = types.get(fault.machineId);
      if (fault.kind === 'stuckSensor' && type) {
        const numeric = measurementNamesFor(type).filter((m) => m !== STATUS_MEASUREMENT.name);
        if (!numeric.includes(fault.measurement)) {
          ctx.addIssue({
            code: 'custom',
            path: ['faults', i, 'measurement'],
            message: `"${fault.measurement}" is not a ${type} measurement (${numeric.join(', ')})`,
          });
        }
      }
    });
    config.idleWindows.forEach((w, i) => {
      checkMachine(w.machineId, ['idleWindows', i, 'machineId']);
    });

    if (config.transport === 'mqtt' && !config.mqtt) {
      ctx.addIssue({
        code: 'custom',
        path: ['mqtt'],
        message: 'TRANSPORT=mqtt needs IOT_ENDPOINT, CERT_PATH, KEY_PATH, and CLIENT_ID',
      });
    }
  });

export type SimulatorConfig = z.infer<typeof SimulatorConfigSchema>;
export type Env = Readonly<Record<string, string | undefined>>;

function numberFromEnv(value: string | undefined): number | undefined {
  return value === undefined || value === '' ? undefined : Number(value);
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
}

/**
 * Configuration precedence: schema defaults, then the JSON file at `CONFIG_FILE`, then
 * environment variables (FR-SIM-6). Under Greengrass (Phase 6) the component configuration
 * replaces the file and can be changed live by a deployment config merge.
 */
export function loadConfig(
  env: Env,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): SimulatorConfig {
  let fromFile: Record<string, unknown> = {};
  if (env.CONFIG_FILE) {
    try {
      fromFile = JSON.parse(readFile(env.CONFIG_FILE)) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Cannot read CONFIG_FILE ${env.CONFIG_FILE}: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }

  const mqttFromEnv = compact({
    endpoint: env.IOT_ENDPOINT,
    certPath: env.CERT_PATH,
    keyPath: env.KEY_PATH,
    clientId: env.CLIENT_ID,
    caPath: env.CA_PATH,
  });
  const fileMqtt = (fromFile.mqtt ?? {}) as Record<string, unknown>;
  const mqtt = { ...fileMqtt, ...mqttFromEnv };

  const merged = {
    ...fromFile,
    ...compact({
      transport: env.TRANSPORT,
      seed: numberFromEnv(env.SEED),
      intervalMs: numberFromEnv(env.INTERVAL_MS),
      bufferMax: numberFromEnv(env.BUFFER_MAX),
      logLevel: env.LOG_LEVEL,
    }),
    // CA_PATH alone (set in the container image for every mode) does not imply MQTT.
    ...(Object.keys(mqtt).some((key) => key !== 'caPath') ? { mqtt } : {}),
  };

  const result = SimulatorConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(`Invalid simulator config:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
