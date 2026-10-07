import { describe, expect, it } from 'vitest';
import { aliasesForMachine, aliasFor } from './aliases.js';
import { listMachines } from './topology.js';
import { firstMachine } from './test-helpers.js';

describe('aliasFor', () => {
  it('builds the SRS 4.4 alias', () => {
    expect(aliasFor('kochi-01', 'line-a', 'pump-01', 'temperature_c')).toBe(
      '/kochi-01/line-a/pump-01/temperature_c',
    );
  });

  it.each([
    ['siteId', ['Kochi', 'line-a', 'pump-01', 'temperature_c']],
    ['lineId', ['kochi-01', 'line a', 'pump-01', 'temperature_c']],
    ['machineId', ['kochi-01', 'line-a', 'pump/01', 'temperature_c']],
    ['measurement', ['kochi-01', 'line-a', 'pump-01', 'Temperature']],
  ] as const)('rejects an invalid %s', (label, [site, line, machine, measurement]) => {
    expect(() => aliasFor(site, line, machine, measurement)).toThrow(new RegExp(label));
  });
});

describe('aliasesForMachine', () => {
  it('covers every measurement including status', () => {
    const aliases = aliasesForMachine(firstMachine());
    expect(aliases).toHaveLength(5);
    expect(aliases.at(-1)).toEqual({
      measurement: 'status',
      alias: '/kochi-01/line-a/pump-01/status',
    });
  });

  it('produces aliases that are unique across the whole topology', () => {
    const all = listMachines().flatMap((m) => aliasesForMachine(m).map((a) => a.alias));
    expect(all).toHaveLength(25);
    expect(new Set(all).size).toBe(all.length);
  });
});
