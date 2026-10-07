import { describe, expect, it } from 'vitest';
import { findMachine, listMachines, topology, validateTopology } from './topology.js';

const valid = {
  site: { id: 'site-1', name: 'Site' },
  lines: [{ id: 'line-1', name: 'Line', machines: [{ id: 'm-1', type: 'pump' }] }],
};

function withMachines(machines: { id: string; type: string }[]) {
  return { ...valid, lines: [{ ...valid.lines[0], machines }] };
}

describe('topology', () => {
  it('ships 1 site, 2 lines, and 5 machines (SRS 4.1)', () => {
    expect(topology.site.id).toBe('kochi-01');
    expect(topology.lines.map((l) => l.id)).toEqual(['line-a', 'line-b']);
    expect(listMachines()).toHaveLength(5);
  });

  it('accepts a minimal valid topology', () => {
    expect(validateTopology(valid)).toEqual(valid);
  });

  it.each([
    ['uppercase', 'Pump-01'],
    ['underscore', 'pump_01'],
    ['slash', 'pump/01'],
    ['leading hyphen', '-pump'],
    ['trailing hyphen', 'pump-'],
    ['double hyphen', 'pump--01'],
    ['empty', ''],
    ['too long', 'a'.repeat(65)],
  ])('rejects a machine id with %s', (_case, id) => {
    expect(() => validateTopology(withMachines([{ id, type: 'pump' }]))).toThrow(
      /Invalid topology/,
    );
  });

  it('rejects an unknown machine type', () => {
    expect(() => validateTopology(withMachines([{ id: 'x-1', type: 'turbine' }]))).toThrow(
      /Invalid topology/,
    );
  });

  it('rejects duplicate machine ids across lines', () => {
    const input = {
      ...valid,
      lines: [
        { id: 'line-1', name: 'L1', machines: [{ id: 'm-1', type: 'pump' }] },
        { id: 'line-2', name: 'L2', machines: [{ id: 'm-1', type: 'compressor' }] },
      ],
    };
    expect(() => validateTopology(input)).toThrow(/duplicate id "m-1" \(also a machine\)/);
  });

  it('rejects a line id that collides with the site id', () => {
    const input = { ...valid, lines: [{ ...valid.lines[0], id: 'site-1' }] };
    expect(() => validateTopology(input)).toThrow(/duplicate id "site-1" \(also a site\)/);
  });

  it('rejects empty lines and empty machine lists', () => {
    expect(() => validateTopology({ ...valid, lines: [] })).toThrow();
    expect(() => validateTopology(withMachines([]))).toThrow();
  });

  it('lists machines with their full key and type', () => {
    expect(listMachines()[0]).toEqual({
      siteId: 'kochi-01',
      lineId: 'line-a',
      machineId: 'pump-01',
      type: 'pump',
    });
  });

  it('finds a machine by key, or returns undefined', () => {
    expect(findMachine('kochi-01', 'line-b', 'comp-02')?.type).toBe('compressor');
    expect(findMachine('kochi-01', 'line-a', 'comp-02')).toBeUndefined();
  });
});
