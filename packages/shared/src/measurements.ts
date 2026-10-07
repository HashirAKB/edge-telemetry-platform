/**
 * Measurements per machine type (SRS 4.2). Infra builds SiteWise measurement properties and
 * rule entries from these descriptors; the simulator generates signals from `signal`.
 */

export const MACHINE_TYPES = ['pump', 'compressor'] as const;
export type MachineType = (typeof MACHINE_TYPES)[number];

export const MACHINE_STATUSES = ['RUNNING', 'IDLE', 'FAULT'] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

/**
 * Parameters for a simulated signal. The simulator combines them as
 * `base * (1 - loadSensitivity + loadSensitivity * load) + drift + daily sine + noise`,
 * delayed by `lagSeconds` relative to load changes, then clamped to `[min, max]`.
 */
export interface SignalProfile {
  /** Value at full load. */
  readonly base: number;
  /** Fraction of `base` that scales with load (0 = load-independent, 1 = proportional). */
  readonly loadSensitivity: number;
  /** Slow linear drift, in units per hour. */
  readonly driftPerHour: number;
  /** Amplitude of the 24 h sine component (ambient temperature, shift patterns). */
  readonly dailyAmplitude: number;
  /** Standard deviation of Gaussian noise per sample. */
  readonly noiseStdDev: number;
  /** First-order lag behind load changes; temperature responds slowly, flow instantly. */
  readonly lagSeconds: number;
  /** Physical limits; generated values are clamped to this range. */
  readonly min: number;
  readonly max: number;
}

export interface NumericMeasurementDescriptor {
  readonly name: string;
  readonly unit: string;
  readonly dataType: 'DOUBLE';
  readonly signal: SignalProfile;
}

export const STATUS_MEASUREMENT = {
  name: 'status',
  unit: 'enum',
  dataType: 'STRING',
} as const;

// Signal values are illustrative, chosen to look plausible for a small centrifugal pump and a
// screw compressor. They are not taken from a datasheet.
export const NUMERIC_MEASUREMENTS = {
  pump: [
    {
      name: 'temperature_c',
      unit: 'Celsius',
      dataType: 'DOUBLE',
      signal: {
        base: 60,
        loadSensitivity: 0.25,
        driftPerHour: 0.05,
        dailyAmplitude: 2,
        noiseStdDev: 0.3,
        lagSeconds: 120,
        min: -20,
        max: 150,
      },
    },
    {
      name: 'vibration_mm_s',
      unit: 'mm/s',
      dataType: 'DOUBLE',
      signal: {
        base: 3,
        loadSensitivity: 0.5,
        driftPerHour: 0,
        dailyAmplitude: 0.1,
        noiseStdDev: 0.15,
        lagSeconds: 0,
        min: 0,
        max: 50,
      },
    },
    {
      name: 'pressure_bar',
      unit: 'bar',
      dataType: 'DOUBLE',
      signal: {
        base: 5,
        loadSensitivity: 0.6,
        driftPerHour: 0,
        dailyAmplitude: 0.1,
        noiseStdDev: 0.05,
        lagSeconds: 0,
        min: 0,
        max: 16,
      },
    },
    {
      name: 'flow_lpm',
      unit: 'L/min',
      dataType: 'DOUBLE',
      signal: {
        base: 210,
        loadSensitivity: 0.9,
        driftPerHour: 0,
        dailyAmplitude: 5,
        noiseStdDev: 2,
        lagSeconds: 0,
        min: 0,
        max: 400,
      },
    },
  ],
  compressor: [
    {
      name: 'temperature_c',
      unit: 'Celsius',
      dataType: 'DOUBLE',
      signal: {
        base: 75,
        loadSensitivity: 0.3,
        driftPerHour: 0.05,
        dailyAmplitude: 3,
        noiseStdDev: 0.4,
        lagSeconds: 180,
        min: -20,
        max: 180,
      },
    },
    {
      name: 'vibration_mm_s',
      unit: 'mm/s',
      dataType: 'DOUBLE',
      signal: {
        base: 4,
        loadSensitivity: 0.5,
        driftPerHour: 0,
        dailyAmplitude: 0.1,
        noiseStdDev: 0.2,
        lagSeconds: 0,
        min: 0,
        max: 50,
      },
    },
    {
      name: 'discharge_pressure_bar',
      unit: 'bar',
      dataType: 'DOUBLE',
      signal: {
        base: 8,
        loadSensitivity: 0.5,
        driftPerHour: 0,
        dailyAmplitude: 0.1,
        noiseStdDev: 0.08,
        lagSeconds: 0,
        min: 0,
        max: 16,
      },
    },
    {
      name: 'motor_current_a',
      unit: 'A',
      dataType: 'DOUBLE',
      signal: {
        base: 45,
        loadSensitivity: 0.8,
        driftPerHour: 0,
        dailyAmplitude: 0.5,
        noiseStdDev: 0.5,
        lagSeconds: 0,
        min: 0,
        max: 120,
      },
    },
  ],
} as const satisfies Record<MachineType, readonly NumericMeasurementDescriptor[]>;

/** Numeric measurement names for a machine type, as a literal union. */
export type NumericMeasurementName<T extends MachineType> =
  (typeof NUMERIC_MEASUREMENTS)[T][number]['name'];

export function numericMeasurementsFor(type: MachineType): readonly NumericMeasurementDescriptor[] {
  return NUMERIC_MEASUREMENTS[type];
}

/** Every measurement name for a type, numeric first, then `status`. */
export function measurementNamesFor(type: MachineType): string[] {
  return [...numericMeasurementsFor(type).map((m) => m.name), STATUS_MEASUREMENT.name];
}
