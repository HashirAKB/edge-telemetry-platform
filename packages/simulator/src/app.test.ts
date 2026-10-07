import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger, isLogLevel } from './logger.js';
import { FakeTransport, memoryLogger } from './test-helpers.js';

describe('startApp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 7, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes one message per machine per interval (FR-SIM-1)', async () => {
    const transport = new FakeTransport();
    const app = await startApp(loadConfig({}), transport, memoryLogger());
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.published).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.published).toHaveLength(15);
    await app.shutdown('test');
  });

  it('does not drift: ticks stay on the interval grid', async () => {
    const transport = new FakeTransport();
    const app = await startApp(loadConfig({ INTERVAL_MS: '1000' }), transport, memoryLogger());
    await vi.advanceTimersByTimeAsync(60_000);
    const stamps = [
      ...new Set(transport.published.map((m) => (JSON.parse(m.payload) as { ts: number }).ts)),
    ];
    expect(stamps).toHaveLength(61);
    const [firstTs = 0] = stamps;
    expect(stamps.every((ts, i) => ts === firstTs + i * 1000)).toBe(true);
    await app.shutdown('test');
  });

  it('on SIGTERM stops sampling, flushes the buffer, and closes the transport (FR-SIM-8)', async () => {
    const transport = new FakeTransport();
    let fail = true;
    transport.behaviour = () => {
      if (fail) throw new Error('nucleus restarting');
    };
    const logger = memoryLogger();
    const app = await startApp(loadConfig({}), transport, logger);
    await vi.advanceTimersByTimeAsync(0);
    expect(app.publisher.stats.buffered).toBe(5);

    fail = false;
    const done = app.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    await done;

    expect(app.simulator.running).toBe(false);
    expect(transport.published).toHaveLength(5);
    expect(transport.closed).toBe(true);
    const stopped = logger.entries.find((e) => e.msg === 'stopped');
    expect(stopped?.fields).toMatchObject({ published: 5, unsent: 0 });

    // A second signal reuses the same shutdown.
    await expect(app.shutdown('SIGINT')).resolves.toBeUndefined();
  });

  it('logs a sample error for one machine without stopping the others', async () => {
    const transport = new FakeTransport();
    const logger = memoryLogger();
    const app = await startApp(loadConfig({}), transport, logger);
    const [first] = app.simulator.machines;
    if (!first) throw new Error('no machines');
    vi.spyOn(first, 'sample').mockImplementation(() => {
      throw new Error('contract bug');
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(logger.entries.some((e) => e.msg === 'sample failed')).toBe(true);
    expect(transport.published.length).toBeGreaterThanOrEqual(9);
    await app.shutdown('test');
  });
});

describe('createLogger (FR-SIM-9)', () => {
  it('writes JSON lines at or above the configured level', () => {
    const lines: string[] = [];
    const logger = createLogger('warn', (l) => lines.push(l), { component: 'sim' });
    logger.debug('d');
    logger.info('i');
    logger.warn('w', { n: 1 });
    logger.error('e');
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toMatchObject([
      { level: 'warn', msg: 'w', n: 1, component: 'sim' },
      { level: 'error', msg: 'e' },
    ]);
    expect(isLogLevel('warn')).toBe(true);
    expect(isLogLevel('loud')).toBe(false);
  });
});
