import {
  MACHINE_TYPES,
  NUMERIC_MEASUREMENTS,
  STATUS_MEASUREMENT,
  VIBRATION_ALERT_THRESHOLD_MM_S,
  type MachineType,
} from './measurements.js';

/**
 * SiteWise asset models as plain data (SRS 4.3). Infra maps these to CloudFormation and the
 * API can use them to label property kinds. Expression syntax follows the SiteWise formula
 * reference (checked 2026-10-09); see ADR 0012 for where it differs from the SRS.
 */

export type ModelType = 'site' | 'line' | MachineType;
export type MetricWindow = '1m' | '5m';
export type SiteWiseDataType = 'DOUBLE' | 'STRING';

export interface VariableRef {
  /** Property name on this model, or on the child model when `hierarchy` is set. */
  readonly property: string;
  readonly hierarchy?: string;
}

interface BaseProperty {
  readonly name: string;
  readonly unit?: string;
  readonly dataType: SiteWiseDataType;
}

export interface MeasurementSpec extends BaseProperty {
  readonly kind: 'measurement';
}
export interface TransformSpec extends BaseProperty {
  readonly kind: 'transform';
  readonly expression: string;
  readonly variables: Readonly<Record<string, VariableRef>>;
}
export interface MetricSpec extends BaseProperty {
  readonly kind: 'metric';
  readonly expression: string;
  readonly window: MetricWindow;
  readonly variables: Readonly<Record<string, VariableRef>>;
}
export interface AttributeSpec extends BaseProperty {
  readonly kind: 'attribute';
  readonly defaultValue: string;
}
export type PropertySpec = MeasurementSpec | TransformSpec | MetricSpec | AttributeSpec;

export interface HierarchySpec {
  readonly name: string;
  readonly childModel: ModelType;
}

export interface ModelSpec {
  readonly type: ModelType;
  readonly name: string;
  readonly description: string;
  readonly properties: readonly PropertySpec[];
  readonly hierarchies: readonly HierarchySpec[];
}

const own = (property: string): VariableRef => ({ property });
const child = (hierarchy: string, property: string): VariableRef => ({ property, hierarchy });

function measurements(type: MachineType): MeasurementSpec[] {
  return [
    ...NUMERIC_MEASUREMENTS[type].map((m) => ({
      kind: 'measurement' as const,
      name: m.name,
      unit: m.unit,
      dataType: m.dataType,
    })),
    { kind: 'measurement', name: STATUS_MEASUREMENT.name, dataType: STATUS_MEASUREMENT.dataType },
  ];
}

/** Transforms shared by every machine type. */
const MACHINE_TRANSFORMS: TransformSpec[] = [
  {
    kind: 'transform',
    name: 'temperature_f',
    unit: 'Fahrenheit',
    dataType: 'DOUBLE',
    expression: 'temp_c * 9 / 5 + 32',
    variables: { temp_c: own('temperature_c') },
  },
  {
    kind: 'transform',
    name: 'vibration_alert',
    dataType: 'DOUBLE',
    // gt() already returns 1 or 0, so the SRS's if(gt(...), 1, 0) wrapper is unnecessary.
    expression: `gt(vibration, ${VIBRATION_ALERT_THRESHOLD_MM_S})`,
    variables: { vibration: own('vibration_mm_s') },
  },
];

function metric(
  name: string,
  window: MetricWindow,
  expression: string,
  variables: Record<string, VariableRef>,
  unit?: string,
): MetricSpec {
  return {
    kind: 'metric',
    name,
    window,
    expression,
    variables,
    dataType: 'DOUBLE',
    ...(unit ? { unit } : {}),
  };
}

export const SITEWISE_MODELS: Readonly<Record<ModelType, ModelSpec>> = {
  pump: {
    type: 'pump',
    name: 'etp-pump',
    description: 'Centrifugal pump (simulated)',
    hierarchies: [],
    properties: [
      ...measurements('pump'),
      ...MACHINE_TRANSFORMS,
      metric('avg_temperature_1m', '1m', 'avg(t)', { t: own('temperature_c') }, 'Celsius'),
      // Same 5 m window as the line rollup that reads it (metric inputs must share a window).
      metric('avg_temperature_5m', '5m', 'avg(t)', { t: own('temperature_c') }, 'Celsius'),
      metric('max_vibration_5m', '5m', 'max(v)', { v: own('vibration_mm_s') }, 'mm/s'),
      // Share of the window in alert, scaled to minutes (samples are evenly spaced).
      metric('alert_minutes_5m', '5m', 'avg(a) * 5', { a: own('vibration_alert') }, 'min'),
    ],
  },
  compressor: {
    type: 'compressor',
    name: 'etp-compressor',
    description: 'Screw compressor (simulated)',
    hierarchies: [],
    properties: [
      ...measurements('compressor'),
      ...MACHINE_TRANSFORMS,
      metric('avg_temperature_1m', '1m', 'avg(t)', { t: own('temperature_c') }, 'Celsius'),
      metric('max_vibration_5m', '5m', 'max(v)', { v: own('vibration_mm_s') }, 'mm/s'),
      metric(
        'max_discharge_pressure_5m',
        '5m',
        'max(p)',
        { p: own('discharge_pressure_bar') },
        'bar',
      ),
      metric('avg_motor_current_5m', '5m', 'avg(i)', { i: own('motor_current_a') }, 'A'),
    ],
  },
  line: {
    type: 'line',
    name: 'etp-line',
    description: 'Production line: rollups across its machines',
    hierarchies: [
      { name: 'pumps', childModel: 'pump' },
      { name: 'compressors', childModel: 'compressor' },
    ],
    properties: [
      metric(
        'line_avg_pump_temperature_5m',
        '5m',
        'avg(t)',
        { t: child('pumps', 'avg_temperature_5m') },
        'Celsius',
      ),
      metric(
        'line_max_vibration_5m',
        '5m',
        'max(pv, cv)',
        { pv: child('pumps', 'max_vibration_5m'), cv: child('compressors', 'max_vibration_5m') },
        'mm/s',
      ),
    ],
  },
  site: {
    type: 'site',
    name: 'etp-site',
    description: 'Plant site: rollups across its lines',
    hierarchies: [{ name: 'lines', childModel: 'line' }],
    properties: [
      { kind: 'attribute', name: 'timezone', dataType: 'STRING', defaultValue: 'Asia/Kolkata' },
      metric(
        'site_max_line_vibration_5m',
        '5m',
        'max(v)',
        { v: child('lines', 'line_max_vibration_5m') },
        'mm/s',
      ),
    ],
  },
};

/** Children before parents: the order CloudFormation must create models in. */
export const MODEL_CREATION_ORDER: readonly ModelType[] = [...MACHINE_TYPES, 'line', 'site'];

/**
 * Checks every variable against the rules in the SiteWise docs: it must name an existing
 * property; transforms can only read their own model; and a metric that reads another metric
 * must use the same window. Returns a list of problems (empty when valid).
 */
export function validateModels(models: Readonly<Record<ModelType, ModelSpec>>): string[] {
  const problems: string[] = [];
  for (const model of Object.values(models)) {
    const names = new Set<string>();
    for (const p of model.properties) {
      if (names.has(p.name)) problems.push(`${model.type}: duplicate property ${p.name}`);
      names.add(p.name);
    }
    for (const p of model.properties) {
      if (p.kind !== 'transform' && p.kind !== 'metric') continue;
      for (const [variable, ref] of Object.entries(p.variables)) {
        const where = `${model.type}.${p.name} variable ${variable}`;
        if (!p.expression.includes(variable)) problems.push(`${where} is unused`);
        let target: PropertySpec | undefined;
        if (ref.hierarchy) {
          if (p.kind === 'transform') problems.push(`${where}: transforms cannot read children`);
          const hierarchy = model.hierarchies.find((h) => h.name === ref.hierarchy);
          if (!hierarchy) {
            problems.push(`${where}: unknown hierarchy ${ref.hierarchy}`);
            continue;
          }
          target = models[hierarchy.childModel].properties.find((q) => q.name === ref.property);
        } else {
          target = model.properties.find((q) => q.name === ref.property);
        }
        if (!target) {
          problems.push(`${where}: unknown property ${ref.property}`);
        } else if (p.kind === 'metric' && target.kind === 'metric' && target.window !== p.window) {
          problems.push(`${where}: reads a ${target.window} metric from a ${p.window} metric`);
        }
      }
    }
  }
  return problems;
}

/** Asset external ID, e.g. `kochi-01.line-a.pump-01`. IDs never contain dots (see ids.ts). */
export function assetExternalIdFor(...ids: readonly string[]): string {
  return ids.join('.');
}
