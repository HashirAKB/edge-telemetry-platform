import { z } from 'zod';
import { Id } from '@etp/shared';
import { isInWindow, type Window } from './load.js';

const timing = {
  machineId: Id,
  /** Seconds after simulator start (or after the config that added it was applied). */
  startOffsetSec: z.number().nonnegative(),
  durationSec: z.number().positive(),
};

/** FR-SIM-3 fault definitions, validated as part of the simulator config. */
export const FaultSpec = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('bearingWear'),
    ...timing,
    /** Vibration multiplier reached at the end of the ramp. */
    peakMultiplier: z.number().gt(1).default(3.5),
    rampSec: z.number().positive().default(300),
  }),
  z.strictObject({
    kind: z.literal('overheat'),
    ...timing,
    stepC: z.number().positive().default(15),
    risePerMinuteC: z.number().nonnegative().default(1),
  }),
  z.strictObject({
    kind: z.literal('stuckSensor'),
    ...timing,
    measurement: z.string(),
  }),
  z.strictObject({ kind: z.literal('dropout'), ...timing }),
]);
export type FaultSpec = z.infer<typeof FaultSpec>;
export type FaultKind = FaultSpec['kind'];

export type Metrics = Record<string, number>;

function elapsedInFault(fault: Window, elapsedMs: number): number {
  return elapsedMs - fault.startOffsetSec * 1000;
}

/** Applies the faults scheduled for one machine to its clean signal values. */
export class FaultEngine {
  private readonly frozen = new Map<string, number>();

  constructor(private readonly faults: readonly FaultSpec[]) {}

  active(elapsedMs: number): FaultSpec[] {
    return this.faults.filter((f) => isInWindow(f, elapsedMs));
  }

  /** A dropout means the machine publishes nothing at all (it is "offline"). */
  isDroppedOut(elapsedMs: number): boolean {
    return this.active(elapsedMs).some((f) => f.kind === 'dropout');
  }

  apply(elapsedMs: number, clean: Metrics): Metrics {
    const values = { ...clean };
    const active = this.active(elapsedMs);

    for (const fault of active) {
      const sinceStartMs = elapsedInFault(fault, elapsedMs);
      switch (fault.kind) {
        case 'bearingWear': {
          if (values.vibration_mm_s !== undefined) {
            const progress = Math.min(1, sinceStartMs / (fault.rampSec * 1000));
            values.vibration_mm_s *= 1 + (fault.peakMultiplier - 1) * progress;
          }
          break;
        }
        case 'overheat': {
          if (values.temperature_c !== undefined) {
            values.temperature_c += fault.stepC + (fault.risePerMinuteC * sinceStartMs) / 60_000;
          }
          break;
        }
        case 'stuckSensor': {
          const current = values[fault.measurement];
          if (current !== undefined) {
            const key = stuckKey(fault);
            if (!this.frozen.has(key)) this.frozen.set(key, current);
            values[fault.measurement] = this.frozen.get(key) ?? current;
          }
          break;
        }
        case 'dropout':
          break;
      }
    }

    // A sensor un-sticks when its fault window ends.
    for (const key of this.frozen.keys()) {
      if (!active.some((f) => f.kind === 'stuckSensor' && stuckKey(f) === key)) {
        this.frozen.delete(key);
      }
    }
    return values;
  }
}

function stuckKey(fault: Extract<FaultSpec, { kind: 'stuckSensor' }>): string {
  return `${fault.measurement}@${fault.startOffsetSec}`;
}
