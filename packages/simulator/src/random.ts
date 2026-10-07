/** 32-bit FNV-1a hash, used to derive independent per-machine seeds from one global seed. */
export function hashSeed(...parts: readonly (string | number)[]): number {
  let hash = 0x811c9dc5;
  for (const char of parts.join('\u0000')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Small, fast, seedable PRNG (mulberry32). `Math.random()` cannot be seeded, and FR-SIM-2
 * requires the same seed to produce the same series so tests and demos are reproducible.
 */
export class Rng {
  private state: number;
  private spareGaussian: number | undefined;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Standard normal sample (Box-Muller; the second value of each pair is cached). */
  gaussian(): number {
    if (this.spareGaussian !== undefined) {
      const spare = this.spareGaussian;
      this.spareGaussian = undefined;
      return spare;
    }
    const u = 1 - this.next(); // (0, 1], avoids log(0)
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spareGaussian = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
}
