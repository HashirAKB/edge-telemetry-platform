import { z } from 'zod';
import { Id } from './ids.js';
import { MACHINE_TYPES, type MachineType } from './measurements.js';

/**
 * Plant topology: the single source of truth for CDK assets, property aliases, simulator
 * devices, and topic names (ADR 0001). Adding a machine here is the only change needed.
 */
const rawTopology = {
  site: { id: 'kochi-01', name: 'Kochi Plant 01' },
  lines: [
    {
      id: 'line-a',
      name: 'Line A',
      machines: [
        { id: 'pump-01', type: 'pump' },
        { id: 'pump-02', type: 'pump' },
        { id: 'comp-01', type: 'compressor' },
      ],
    },
    {
      id: 'line-b',
      name: 'Line B',
      machines: [
        { id: 'pump-03', type: 'pump' },
        { id: 'comp-02', type: 'compressor' },
      ],
    },
  ],
} as const;

const NamedNode = z.object({ id: Id, name: z.string().min(1).max(128) });

export const TopologySchema = z
  .object({
    site: NamedNode,
    lines: z
      .array(
        NamedNode.extend({
          machines: z
            .array(z.object({ id: Id, type: z.enum(MACHINE_TYPES) }))
            .min(1)
            .readonly(),
        }),
      )
      .min(1)
      .readonly(),
  })
  .superRefine((topology, ctx) => {
    // Line IDs must be unique within the site; machine IDs must be unique across the site,
    // because the simulator, payload `machineId`, and logs identify a machine by ID alone.
    const seen = new Map<string, string>();
    const claim = (id: string, kind: string, path: (string | number)[]): void => {
      const previous = seen.get(id);
      if (previous) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `duplicate id "${id}" (also a ${previous})`,
        });
      } else {
        seen.set(id, kind);
      }
    };
    claim(topology.site.id, 'site', ['site', 'id']);
    topology.lines.forEach((line, li) => {
      claim(line.id, 'line', ['lines', li, 'id']);
      line.machines.forEach((machine, mi) => {
        claim(machine.id, 'machine', ['lines', li, 'machines', mi, 'id']);
      });
    });
  });

export type Topology = z.infer<typeof TopologySchema>;

/** Validate a topology, throwing a readable error listing every problem. */
export function validateTopology(input: unknown): Topology {
  const result = TopologySchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid topology:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

// Validated at module load: a bad topology fails every build, test, and synth immediately.
validateTopology(rawTopology);

export const topology: typeof rawTopology = rawTopology;

export interface MachineNode {
  readonly siteId: string;
  readonly lineId: string;
  readonly machineId: string;
  readonly type: MachineType;
}

export function listMachines(source: Topology = topology): MachineNode[] {
  return source.lines.flatMap((line) =>
    line.machines.map((machine) => ({
      siteId: source.site.id,
      lineId: line.id,
      machineId: machine.id,
      type: machine.type,
    })),
  );
}

export function findMachine(
  siteId: string,
  lineId: string,
  machineId: string,
  source: Topology = topology,
): MachineNode | undefined {
  return listMachines(source).find(
    (m) => m.siteId === siteId && m.lineId === lineId && m.machineId === machineId,
  );
}
