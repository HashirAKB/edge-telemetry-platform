import { describe, expect, it } from 'vitest';
import { listMachines } from '@etp/shared';
import { FreshnessMonitor, NEVER_REPORTED_SECONDS } from './services/freshness.js';
import { FakeSiteWise } from './test-helpers.js';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

describe('FreshnessMonitor (FR-OBS-2)', () => {
  it('reports seconds since the latest temperature_c value for every machine', async () => {
    const sitewise = new FakeSiteWise();
    sitewise.setValue('kochi-01/line-a/pump-01', 'temperature_c', {
      timestampMs: NOW - 4_000,
      quality: 'GOOD',
      value: 60,
    });
    sitewise.setValue('kochi-01/line-b/comp-02', 'temperature_c', {
      timestampMs: NOW - 300_400,
      quality: 'GOOD',
      value: 70,
    });
    const results = await new FreshnessMonitor(sitewise, listMachines(), () => NOW).measure();
    expect(results.map((r) => r.machineId)).toEqual(listMachines().map((m) => m.machineId));
    expect(results.find((r) => r.machineId === 'pump-01')?.secondsSinceLastValue).toBe(4);
    expect(results.find((r) => r.machineId === 'comp-02')?.secondsSinceLastValue).toBe(300);
  });

  it('reports machines that never sent a value as stale, not healthy', async () => {
    const sitewise = new FakeSiteWise();
    const results = await new FreshnessMonitor(sitewise, listMachines(), () => NOW).measure();
    expect(results.every((r) => r.secondsSinceLastValue === NEVER_REPORTED_SECONDS)).toBe(true);
  });

  it('resolves property IDs once and then reads in a single batch', async () => {
    const sitewise = new FakeSiteWise();
    const monitor = new FreshnessMonitor(sitewise, listMachines(), () => NOW);
    await monitor.measure();
    const describes = sitewise.calls.describeAsset;
    await monitor.measure();
    expect(sitewise.calls.describeAsset).toBe(describes);
    expect(sitewise.calls.latestValues).toBe(2);
  });

  it('treats a machine with no asset as stale and retries resolution next time', async () => {
    const sitewise = new FakeSiteWise();
    const ghost = {
      siteId: 'kochi-01',
      lineId: 'line-a',
      machineId: 'pump-99',
      type: 'pump' as const,
    };
    const monitor = new FreshnessMonitor(sitewise, [...listMachines(), ghost], () => NOW);
    const first = await monitor.measure();
    expect(first.find((r) => r.machineId === 'pump-99')?.secondsSinceLastValue).toBe(
      NEVER_REPORTED_SECONDS,
    );
    const describes = sitewise.calls.describeAsset;
    await monitor.measure();
    expect(sitewise.calls.describeAsset).toBeGreaterThan(describes);
  });
});
