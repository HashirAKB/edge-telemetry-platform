import type { SimulatorConfig } from './config.js';
import type { Logger } from './logger.js';
import { MachineSimulator } from './machine.js';
import { errorMessage, type Publisher } from './publisher.js';

export interface SimulatorOptions {
  readonly config: SimulatorConfig;
  readonly publisher: Publisher;
  readonly logger: Logger;
  readonly now?: () => number;
}

/**
 * Samples every configured machine once per interval (FR-SIM-1) and hands the messages to the
 * publisher. Ticks are scheduled against the start time, so timing does not drift.
 */
export class Simulator {
  readonly machines: MachineSimulator[];
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private timer: NodeJS.Timeout | undefined;
  private ticks = 0;

  constructor(private readonly options: SimulatorOptions) {
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
    const { config } = options;
    this.machines = config.devices.map(
      (machine) =>
        new MachineSimulator({
          machine,
          seed: config.seed,
          startedAtMs: this.startedAtMs,
          faults: config.faults.filter((f) => f.machineId === machine.machineId),
          idleWindows: config.idleWindows.filter((w) => w.machineId === machine.machineId),
        }),
    );
  }

  start(): void {
    if (this.timer) return;
    this.tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  tick(): void {
    const ts = this.now();
    for (const machine of this.machines) {
      try {
        const sample = machine.sample(ts);
        if (sample) {
          this.options.publisher.enqueue({
            topic: sample.topic,
            payload: JSON.stringify(sample.message),
          });
        }
      } catch (error) {
        // A contract bug in one machine must not stop the others.
        this.options.logger.error('sample failed', {
          machineId: machine.machineId,
          error: errorMessage(error),
        });
      }
    }

    this.ticks += 1;
    const nextAt = this.startedAtMs + this.ticks * this.options.config.intervalMs;
    this.timer = setTimeout(
      () => {
        this.tick();
      },
      Math.max(0, nextAt - this.now()),
    );
  }
}
