import { describe, expect, it } from 'vitest';
import {
  listMachines,
  NUMERIC_MEASUREMENTS,
  parseTelemetryMessage,
  VIBRATION_ALERT_THRESHOLD_MM_S,
  type MachineNode,
} from '@etp/shared';
import { FaultSpec } from './faults.js';
import { MachineSimulator } from './machine.js';

const START = Date.UTC(2026, 9, 7, 0, 0, 0);
const INTERVAL = 5_000;

function machine(id: string): MachineNode {
  const found = listMachines().find((m) => m.machineId === id);
  if (!found) throw new Error(`no machine ${id}`);
  return found;
}

function series(sim: MachineSimulator, samples: number) {
  return Array.from({ length: samples }, (_, i) => sim.sample(START + i * INTERVAL));
}

describe('MachineSimulator', () => {
  it('is deterministic: same seed gives the same series (FR-SIM-2)', () => {
    const a = series(
      new MachineSimulator({ machine: machine('pump-01'), seed: 1, startedAtMs: START }),
      50,
    );
    const b = series(
      new MachineSimulator({ machine: machine('pump-01'), seed: 1, startedAtMs: START }),
      50,
    );
    const c = series(
      new MachineSimulator({ machine: machine('pump-01'), seed: 2, startedAtMs: START }),
      50,
    );
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  it('gives each machine its own independent series', () => {
    const p1 = series(
      new MachineSimulator({ machine: machine('pump-01'), seed: 1, startedAtMs: START }),
      5,
    );
    const p2 = series(
      new MachineSimulator({ machine: machine('pump-02'), seed: 1, startedAtMs: START }),
      5,
    );
    expect(p1.map((s) => s?.message.metrics)).not.toEqual(p2.map((s) => s?.message.metrics));
  });

  it('emits valid messages on the right topic with increasing seq', () => {
    const sim = new MachineSimulator({ machine: machine('comp-02'), seed: 1, startedAtMs: START });
    const [first, second] = series(sim, 2);
    expect(first?.topic).toBe('telemetry/v1/kochi-01/line-b/compressor/comp-02');
    expect(() => parseTelemetryMessage('compressor', first?.message)).not.toThrow();
    expect(first?.message.seq).toBe(0);
    expect(second?.message.seq).toBe(1);
    expect(second?.message.ts).toBe(START + INTERVAL);
  });

  it.each(['pump-01', 'comp-01'])(
    'keeps every signal within physical limits over a simulated day (%s)',
    (id) => {
      const node = machine(id);
      const sim = new MachineSimulator({ machine: node, seed: 99, startedAtMs: START });
      const limits = Object.fromEntries(
        NUMERIC_MEASUREMENTS[node.type].map((m) => [m.name, m.signal]),
      );
      for (let t = 0; t < 24 * 3_600_000; t += 60_000) {
        const sample = sim.sample(START + t);
        for (const [name, value] of Object.entries(sample?.message.metrics ?? {})) {
          expect(value).toBeGreaterThanOrEqual(limits[name]?.min ?? -Infinity);
          expect(value).toBeLessThanOrEqual(limits[name]?.max ?? Infinity);
        }
      }
    },
  );

  it('drives vibration over the alert threshold and status to FAULT under bearing wear', () => {
    const sim = new MachineSimulator({
      machine: machine('pump-02'),
      seed: 1,
      startedAtMs: START,
      faults: [
        FaultSpec.parse({
          kind: 'bearingWear',
          machineId: 'pump-02',
          startOffsetSec: 60,
          durationSec: 600,
        }),
      ],
    });
    const before = sim.sample(START + 30_000);
    expect(before?.message.status).toBe('RUNNING');
    const late = sim.sample(START + 60_000 + 400_000);
    expect(late?.message.metrics).toHaveProperty('vibration_mm_s');
    const vibration = (late?.message.metrics as { vibration_mm_s: number }).vibration_mm_s;
    expect(vibration).toBeGreaterThan(VIBRATION_ALERT_THRESHOLD_MM_S);
    expect(late?.message.status).toBe('FAULT');
  });

  it('publishes nothing during a dropout, and seq does not advance', () => {
    const sim = new MachineSimulator({
      machine: machine('pump-01'),
      seed: 1,
      startedAtMs: START,
      faults: [
        FaultSpec.parse({
          kind: 'dropout',
          machineId: 'pump-01',
          startOffsetSec: 5,
          durationSec: 10,
        }),
      ],
    });
    const out = series(sim, 5); // t = 0, 5, 10, 15, 20 s
    expect(out.map((s) => s?.message.seq ?? null)).toEqual([0, null, null, 1, 2]);
  });

  it('reports IDLE inside an idle window', () => {
    const sim = new MachineSimulator({
      machine: machine('pump-03'),
      seed: 1,
      startedAtMs: START,
      idleWindows: [{ startOffsetSec: 0, durationSec: 60 }],
    });
    expect(sim.sample(START)?.message.status).toBe('IDLE');
    expect(sim.sample(START + 60_000)?.message.status).toBe('RUNNING');
  });
});
