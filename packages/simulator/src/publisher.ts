import { backoffDelayMs, BoundedQueue, DEFAULT_BACKOFF, type BackoffOptions } from './buffer.js';
import type { Logger } from './logger.js';
import type { Transport } from './transports/types.js';

export interface OutboundMessage {
  readonly topic: string;
  readonly payload: string;
}

export interface PublisherStats {
  published: number;
  failedAttempts: number;
  dropped: number;
  buffered: number;
}

export interface PublisherOptions {
  readonly transport: Transport;
  readonly bufferMax: number;
  readonly logger: Logger;
  readonly random?: () => number;
  readonly backoff?: BackoffOptions;
}

/**
 * Publishes messages strictly in order through a bounded in-memory buffer (FR-SIM-7).
 * One message is in flight at a time; on failure it goes back to the front of the queue and
 * the drain loop retries after an exponential backoff with jitter.
 *
 * This buffer covers local publish failures (for example the Greengrass nucleus restarting).
 * Network outages are covered further down by the MQTT client and the Greengrass spooler.
 */
export class Publisher {
  private readonly queue: BoundedQueue<OutboundMessage>;
  private readonly random: () => number;
  private readonly backoff: BackoffOptions;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private draining: Promise<void> | undefined;
  private readonly counters = { published: 0, failedAttempts: 0, dropped: 0 };

  constructor(private readonly options: PublisherOptions) {
    this.queue = new BoundedQueue(options.bufferMax);
    this.random = options.random ?? Math.random;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
  }

  get stats(): PublisherStats {
    return { ...this.counters, buffered: this.queue.size };
  }

  enqueue(message: OutboundMessage): void {
    const dropped = this.queue.push(message);
    if (dropped) this.recordDrop(dropped);
    this.kick();
  }

  /**
   * Best-effort flush for shutdown (FR-SIM-8): retry immediately, without backoff, until the
   * buffer is empty or the deadline passes. Returns how many messages were left unsent.
   */
  async flush(timeoutMs: number): Promise<number> {
    this.clearRetry();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // Race the deadline: an in-flight publish can hang while the connection is down.
      const timeout = delay(remaining);
      await Promise.race([this.drainOnce(), timeout.promise]);
      timeout.cancel();
      if (this.queue.size === 0 && !this.draining) break;
      this.clearRetry();
      const pauseMs = Math.min(100, deadline - Date.now());
      if (pauseMs <= 0) break;
      await delay(pauseMs).promise;
    }
    this.clearRetry();
    // A message still in flight at the deadline counts as unsent.
    return this.queue.size + (this.draining ? 1 : 0);
  }

  private kick(): void {
    if (this.draining || this.retryTimer) return;
    void this.drainOnce();
  }

  private drainOnce(): Promise<void> {
    this.draining ??= this.drain().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async drain(): Promise<void> {
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      try {
        await this.options.transport.publish(next.topic, next.payload);
        this.counters.published += 1;
        if (this.attempt > 0) {
          this.options.logger.info('publish recovered', { afterAttempts: this.attempt });
        }
        this.attempt = 0;
      } catch (error) {
        this.counters.failedAttempts += 1;
        if (!this.queue.unshift(next)) this.recordDrop(next);
        const delayMs = backoffDelayMs(this.attempt, this.random, this.backoff);
        this.attempt += 1;
        this.options.logger.warn('publish failed, will retry', {
          error: errorMessage(error),
          attempt: this.attempt,
          retryInMs: delayMs,
          buffered: this.queue.size,
        });
        this.scheduleRetry(delayMs);
        return;
      }
    }
  }

  private scheduleRetry(delayMs: number): void {
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.kick();
    }, delayMs);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private recordDrop(message: OutboundMessage): void {
    this.counters.dropped += 1;
    this.options.logger.warn('buffer full, dropped oldest message', {
      topic: message.topic,
      dropped: this.counters.dropped,
    });
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A cancellable sleep, so a finished race leaves no timer behind. */
function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms));
  });
  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}
