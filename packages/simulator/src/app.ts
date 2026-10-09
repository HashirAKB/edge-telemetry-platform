import type { SimulatorConfig } from './config.js';
import type { Logger } from './logger.js';
import { errorMessage, Publisher } from './publisher.js';
import { Simulator } from './simulator.js';
import { withTimeout, type Transport } from './transports/types.js';

/** SIGTERM budget (FR-SIM-8). Greengrass and Docker wait a little longer before SIGKILL. */
export const SHUTDOWN_FLUSH_MS = 5_000;

export interface App {
  readonly simulator: Simulator;
  readonly publisher: Publisher;
  /**
   * Apply a new configuration live (a Greengrass config merge, FR-EDGE-4): restart sampling with
   * the new interval, faults, and idle windows. Fault offsets count from now; `seq` continues.
   * The publisher and its buffer are kept.
   */
  reconfigure(config: SimulatorConfig): void;
  /** Stop sampling, flush the buffer best-effort, close the transport. Never throws. */
  shutdown(signal: string): Promise<void>;
}

export async function startApp(
  config: SimulatorConfig,
  transport: Transport,
  logger: Logger,
  flushMs: number = SHUTDOWN_FLUSH_MS,
): Promise<App> {
  await transport.connect();
  const publisher = new Publisher({ transport, bufferMax: config.bufferMax, logger });
  let simulator = new Simulator({ config, publisher, logger });
  simulator.start();
  logger.info('simulator started', {
    transport: transport.name,
    machines: config.devices.map((d) => d.machineId),
    intervalMs: config.intervalMs,
    faults: config.faults.length,
  });

  let stopping: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    stopping ??= (async () => {
      logger.info('shutting down', { signal, buffered: publisher.stats.buffered });
      simulator.stop();
      const unsent = await publisher.flush(flushMs);
      try {
        await withTimeout(transport.close(), 2_000, 'transport close');
      } catch (error) {
        logger.warn('transport close failed', { error: errorMessage(error) });
      }
      logger.info('stopped', { ...publisher.stats, unsent });
    })();
    return stopping;
  };

  const reconfigure = (next: SimulatorConfig): void => {
    if (stopping) return;
    const initialSeq = simulator.nextSeqs();
    simulator.stop();
    simulator = new Simulator({ config: next, publisher, logger, initialSeq });
    simulator.start();
    logger.info('configuration applied', {
      intervalMs: next.intervalMs,
      faults: next.faults.map((f) => `${f.kind}:${f.machineId}`),
    });
  };

  return {
    get simulator() {
      return simulator;
    },
    publisher,
    reconfigure,
    shutdown,
  };
}
