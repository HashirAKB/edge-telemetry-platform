import type { Rng } from './random.js';

const HOUR_MS = 3_600_000;
const SHIFT_MS = 8 * HOUR_MS;

export const IDLE_LOAD = 0.05;
const MIN_RUNNING_LOAD = 0.3;
const MAX_LOAD = 1;

export interface Window {
  readonly startOffsetSec: number;
  readonly durationSec: number;
}

export function isInWindow(window: Window, elapsedMs: number): boolean {
  const start = window.startOffsetSec * 1000;
  return elapsedMs >= start && elapsedMs < start + window.durationSec * 1000;
}

/**
 * Machine load in [0, 1]: a slow shift-length cycle plus a mean-reverting random walk
 * (Ornstein-Uhlenbeck), so load wanders realistically instead of jumping sample to sample.
 */
export class LoadModel {
  private walk = 0;
  private lastElapsedMs: number | undefined;
  private readonly phase: number;

  constructor(
    private readonly rng: Rng,
    private readonly idleWindows: readonly Window[] = [],
  ) {
    this.phase = rng.next() * 2 * Math.PI;
  }

  isIdle(elapsedMs: number): boolean {
    return this.idleWindows.some((w) => isInWindow(w, elapsedMs));
  }

  at(elapsedMs: number): number {
    const dtHours = Math.max(0, elapsedMs - (this.lastElapsedMs ?? elapsedMs)) / HOUR_MS;
    this.lastElapsedMs = elapsedMs;

    // Mean reversion rate 2/h and volatility 0.15/sqrt(h): drifts over tens of minutes.
    this.walk += -2 * this.walk * dtHours + 0.15 * Math.sqrt(dtHours) * this.rng.gaussian();

    if (this.isIdle(elapsedMs)) return IDLE_LOAD;
    const cycle = 0.12 * Math.sin((2 * Math.PI * elapsedMs) / SHIFT_MS + this.phase);
    return Math.min(MAX_LOAD, Math.max(MIN_RUNNING_LOAD, 0.75 + cycle + this.walk));
  }
}
