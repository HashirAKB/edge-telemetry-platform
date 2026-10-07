import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelayMs, BoundedQueue } from './buffer.js';
import { Publisher } from './publisher.js';
import { FakeTransport, memoryLogger } from './test-helpers.js';

const msg = (n: number) => ({ topic: 't', payload: String(n) });

describe('BoundedQueue', () => {
  it('drops the oldest item when full (FR-SIM-7)', () => {
    const q = new BoundedQueue<number>(2);
    expect(q.push(1)).toBeUndefined();
    expect(q.push(2)).toBeUndefined();
    expect(q.push(3)).toBe(1);
    expect([q.shift(), q.shift(), q.shift()]).toEqual([2, 3, undefined]);
  });

  it('refuses to put an item back when full', () => {
    const q = new BoundedQueue<number>(1);
    q.push(1);
    expect(q.unshift(0)).toBe(false);
    q.shift();
    expect(q.unshift(0)).toBe(true);
    expect(q.size).toBe(1);
  });

  it('rejects a non-positive size', () => {
    expect(() => new BoundedQueue(0)).toThrow();
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially with full jitter and caps at the maximum', () => {
    expect(backoffDelayMs(0, () => 0.999)).toBe(499);
    expect(backoffDelayMs(3, () => 0.999)).toBe(3_996);
    expect(backoffDelayMs(20, () => 0.999)).toBe(29_970);
    expect(backoffDelayMs(5, () => 0)).toBe(0);
  });
});

describe('Publisher', () => {
  let transport: FakeTransport;
  let logger: ReturnType<typeof memoryLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new FakeTransport();
    logger = memoryLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const make = (bufferMax = 100) =>
    new Publisher({ transport, bufferMax, logger, random: () => 1 });

  it('publishes in order', async () => {
    const p = make();
    for (let i = 0; i < 5; i++) p.enqueue(msg(i));
    await vi.runAllTimersAsync();
    expect(transport.published.map((m) => m.payload)).toEqual(['0', '1', '2', '3', '4']);
    expect(p.stats).toEqual({ published: 5, failedAttempts: 0, dropped: 0, buffered: 0 });
  });

  it('buffers on failure and retries with exponential backoff, keeping order', async () => {
    let failures = 3;
    transport.behaviour = () => {
      if (failures-- > 0) throw new Error('nucleus restarting');
    };
    const p = make();
    p.enqueue(msg(1));
    p.enqueue(msg(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(p.stats.failedAttempts).toBe(1);
    expect(p.stats.buffered).toBe(2);

    // random() = 1, so delays are 500, 1000, 2000 ms.
    await vi.advanceTimersByTimeAsync(499);
    expect(p.stats.failedAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.stats.failedAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(p.stats.failedAttempts).toBe(3);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(transport.published.map((m) => m.payload)).toEqual(['1', '2']);
    expect(logger.entries.map((e) => e.msg)).toContain('publish recovered');
  });

  it('does not retry early when new messages arrive during backoff', async () => {
    let fail = true;
    transport.behaviour = () => {
      if (fail) throw new Error('down');
    };
    const p = make();
    p.enqueue(msg(1));
    await vi.advanceTimersByTimeAsync(0);
    fail = false;
    p.enqueue(msg(2));
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.published).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(transport.published.map((m) => m.payload)).toEqual(['1', '2']);
  });

  it('drops the oldest messages when the buffer overflows and counts them', async () => {
    transport.behaviour = () => {
      throw new Error('down');
    };
    const p = make(3);
    for (let i = 0; i < 6; i++) p.enqueue(msg(i));
    await vi.advanceTimersByTimeAsync(0);
    expect(p.stats.dropped).toBe(3);
    expect(p.stats.buffered).toBe(3);

    transport.behaviour = () => undefined;
    await vi.runAllTimersAsync();
    expect(transport.published.map((m) => m.payload)).toEqual(['3', '4', '5']);
  });

  it('flushes immediately on shutdown, without waiting for backoff', async () => {
    let fail = true;
    transport.behaviour = () => {
      if (fail) throw new Error('down');
    };
    const p = make();
    p.enqueue(msg(1));
    await vi.advanceTimersByTimeAsync(0);
    fail = false;
    const unsent = p.flush(5_000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(unsent).resolves.toBe(0);
    expect(transport.published).toHaveLength(1);
  });

  it('gives up flushing at the deadline when publishes hang (FR-SIM-8)', async () => {
    transport.behaviour = () => new Promise(() => undefined);
    const p = make();
    p.enqueue(msg(1));
    p.enqueue(msg(2));
    const unsent = p.flush(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(unsent).resolves.toBe(2);
  });
});
