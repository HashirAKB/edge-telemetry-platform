/** FIFO queue with a hard size limit that drops the oldest item when full (FR-SIM-7). */
export class BoundedQueue<T> {
  private items: T[] = [];

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error('max must be a positive integer');
  }

  get size(): number {
    return this.items.length;
  }

  /** Append; returns the dropped oldest item when the queue was full. */
  push(item: T): T | undefined {
    const dropped = this.items.length >= this.max ? this.items.shift() : undefined;
    this.items.push(item);
    return dropped;
  }

  /** Put an item back at the front (a failed in-flight publish). False if no room. */
  unshift(item: T): boolean {
    if (this.items.length >= this.max) return false;
    this.items.unshift(item);
    return true;
  }

  shift(): T | undefined {
    return this.items.shift();
  }
}

export interface BackoffOptions {
  readonly baseMs: number;
  readonly maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 30_000 };

/**
 * Exponential backoff with full jitter: a random delay in [0, min(max, base * 2^attempt)].
 * Jitter stops many devices that failed together from retrying in lockstep.
 */
export function backoffDelayMs(
  attempt: number,
  random: () => number,
  options: BackoffOptions = DEFAULT_BACKOFF,
): number {
  const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}
