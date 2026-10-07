import type { SignalProfile } from '@etp/shared';
import type { Rng } from './random.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Values are rounded to 2 decimals: realistic sensor resolution and smaller payloads. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * One simulated measurement (FR-SIM-2):
 * `base * (1 - s + s * laggedLoad) + drift + daily sine + noise`, clamped to `[min, max]`.
 * `laggedLoad` follows load through a first-order filter, so temperature trails load changes
 * while flow and pressure respond immediately.
 */
export class SignalModel {
  private laggedLoad: number | undefined;
  private lastElapsedMs: number | undefined;

  constructor(
    private readonly profile: SignalProfile,
    private readonly rng: Rng,
  ) {}

  sample(elapsedMs: number, timestampMs: number, load: number): number {
    const p = this.profile;
    const dtSec = Math.max(0, elapsedMs - (this.lastElapsedMs ?? elapsedMs)) / 1000;
    this.lastElapsedMs = elapsedMs;

    if (this.laggedLoad === undefined || p.lagSeconds === 0) {
      this.laggedLoad = load;
    } else {
      this.laggedLoad += (load - this.laggedLoad) * (1 - Math.exp(-dtSec / p.lagSeconds));
    }

    const loadTerm = p.base * (1 - p.loadSensitivity + p.loadSensitivity * this.laggedLoad);
    const drift = p.driftPerHour * (elapsedMs / HOUR_MS);
    const daily = p.dailyAmplitude * Math.sin((2 * Math.PI * (timestampMs % DAY_MS)) / DAY_MS);
    const noise = p.noiseStdDev * this.rng.gaussian();

    return clamp(loadTerm + drift + daily + noise, p.min, p.max);
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
