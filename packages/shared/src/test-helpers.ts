import { listMachines, type MachineNode } from './topology.js';

/** The first machine in the shipped topology (`kochi-01/line-a/pump-01`). */
export function firstMachine(): MachineNode {
  const [machine] = listMachines();
  if (!machine) throw new Error('topology has no machines');
  return machine;
}
