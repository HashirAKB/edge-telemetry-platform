import {
  CONTRACT_VERSION,
  numericMeasurementsFor,
  parseTelemetryMessage,
  topicFor,
  type MachineNode,
  type TelemetryMessageV1,
} from '@etp/shared';
import { FaultEngine, type FaultSpec, type Metrics } from './faults.js';
import { LoadModel, type Window } from './load.js';
import { hashSeed, Rng } from './random.js';
import { round2, SignalModel } from './signals.js';
import { deriveStatus } from './status.js';

export interface MachineOptions {
  readonly machine: MachineNode;
  readonly seed: number;
  /** Epoch ms when the simulator started; fault and idle offsets are relative to it. */
  readonly startedAtMs: number;
  readonly faults?: readonly FaultSpec[];
  readonly idleWindows?: readonly Window[];
}

export interface Sample {
  readonly topic: string;
  readonly message: TelemetryMessageV1;
}

/** One simulated machine: turns a timestamp into a validated v1 message. */
export class MachineSimulator {
  readonly topic: string;
  private readonly load: LoadModel;
  private readonly signals: { name: string; model: SignalModel }[];
  private readonly faults: FaultEngine;
  private seq = 0;

  constructor(private readonly options: MachineOptions) {
    const { machine, seed } = options;
    this.topic = topicFor(machine);
    // Independent streams per machine and per signal: adding a machine or a measurement
    // does not change the series of the others.
    this.load = new LoadModel(new Rng(hashSeed(seed, machine.machineId, 'load')), [
      ...(options.idleWindows ?? []),
    ]);
    this.signals = numericMeasurementsFor(machine.type).map((m) => ({
      name: m.name,
      model: new SignalModel(m.signal, new Rng(hashSeed(seed, machine.machineId, m.name))),
    }));
    this.faults = new FaultEngine(options.faults ?? []);
  }

  get machineId(): string {
    return this.options.machine.machineId;
  }

  /**
   * Sample at `timestampMs`. Returns null during a dropout. `seq` only advances on emitted
   * messages, so any gap in `seq` downstream means a message was lost in transit.
   */
  sample(timestampMs: number): Sample | null {
    const elapsedMs = timestampMs - this.options.startedAtMs;
    const load = this.load.at(elapsedMs);
    const clean: Metrics = {};
    for (const { name, model } of this.signals) {
      clean[name] = model.sample(elapsedMs, timestampMs, load);
    }
    if (this.faults.isDroppedOut(elapsedMs)) return null;

    const faulted = this.faults.apply(elapsedMs, clean);
    const metrics = Object.fromEntries(Object.entries(faulted).map(([k, v]) => [k, round2(v)]));
    const { machine } = this.options;
    const status = deriveStatus({
      type: machine.type,
      idle: this.load.isIdle(elapsedMs),
      activeFaults: this.faults.active(elapsedMs),
      values: metrics,
    });

    // Validate before publishing: a contract bug fails here, on the device, with a clear error.
    const message = parseTelemetryMessage(machine.type, {
      v: CONTRACT_VERSION,
      ts: timestampMs,
      seq: this.seq,
      machineId: machine.machineId,
      metrics,
      status,
    });
    this.seq += 1;
    return { topic: this.topic, message };
  }
}
