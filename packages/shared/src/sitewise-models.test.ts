import { describe, expect, it } from 'vitest';
import { measurementNamesFor } from './measurements.js';
import {
  assetExternalIdFor,
  MODEL_CREATION_ORDER,
  SITEWISE_MODELS,
  validateModels,
  type ModelSpec,
  type ModelType,
} from './sitewise-models.js';

const names = (type: ModelType, kind?: string) =>
  SITEWISE_MODELS[type].properties.filter((p) => !kind || p.kind === kind).map((p) => p.name);

describe('SITEWISE_MODELS (SRS 4.3)', () => {
  it('passes the SiteWise reference rules', () => {
    expect(validateModels(SITEWISE_MODELS)).toEqual([]);
  });

  it.each(['pump', 'compressor'] as const)(
    'gives %s every measurement plus both transforms',
    (t) => {
      expect(names(t, 'measurement')).toEqual(measurementNamesFor(t));
      expect(names(t, 'transform')).toEqual(['temperature_f', 'vibration_alert']);
    },
  );

  it('defines the SRS machine metrics', () => {
    expect(names('pump', 'metric')).toEqual(
      expect.arrayContaining(['avg_temperature_1m', 'max_vibration_5m', 'alert_minutes_5m']),
    );
    expect(names('compressor', 'metric')).toEqual(
      expect.arrayContaining([
        'avg_temperature_1m',
        'max_discharge_pressure_5m',
        'avg_motor_current_5m',
      ]),
    );
  });

  it('rolls up across the hierarchy: machines to lines to site', () => {
    expect(SITEWISE_MODELS.line.hierarchies.map((h) => h.childModel)).toEqual([
      'pump',
      'compressor',
    ]);
    expect(names('line', 'metric')).toEqual([
      'line_avg_pump_temperature_5m',
      'line_max_vibration_5m',
    ]);
    expect(names('site', 'metric')).toEqual(['site_max_line_vibration_5m']);
    expect(names('site', 'attribute')).toEqual(['timezone']);
  });

  it('creates child models before the models that reference them', () => {
    const position = (t: ModelType) => MODEL_CREATION_ORDER.indexOf(t);
    for (const model of Object.values(SITEWISE_MODELS)) {
      for (const h of model.hierarchies) {
        expect(position(h.childModel)).toBeLessThan(position(model.type));
      }
    }
  });
});

describe('validateModels', () => {
  const broken = (patch: (m: Record<ModelType, ModelSpec>) => void) => {
    const copy = structuredClone(SITEWISE_MODELS) as Record<ModelType, ModelSpec>;
    patch(copy);
    return validateModels(copy);
  };
  // Replacing the line model's properties also breaks the site rollup that reads them, so
  // these tests check that the expected problem is reported, not that it is the only one.
  const lineMetric = (
    m: Record<ModelType, ModelSpec>,
    variables: object,
    expression = 'avg(x)',
  ) => {
    m.line = {
      ...m.line,
      properties: [
        { kind: 'metric', name: 'bad', dataType: 'DOUBLE', window: '5m', expression, variables },
      ],
    } as ModelSpec;
  };

  it('rejects a metric that reads a child metric with a different window', () => {
    expect(
      broken((m) => {
        lineMetric(m, { x: { hierarchy: 'pumps', property: 'avg_temperature_1m' } });
      }),
    ).toContain('line.bad variable x: reads a 1m metric from a 5m metric');
  });

  it('rejects unknown properties, unknown hierarchies, and unused variables', () => {
    expect(
      broken((m) => {
        lineMetric(m, { x: { hierarchy: 'pumps', property: 'nope' } });
      }),
    ).toContain('line.bad variable x: unknown property nope');
    expect(
      broken((m) => {
        lineMetric(m, { x: { hierarchy: 'turbines', property: 'x' } });
      }),
    ).toContain('line.bad variable x: unknown hierarchy turbines');
    expect(
      broken((m) => {
        lineMetric(m, { y: { property: 'line_max_vibration_5m' } });
      }),
    ).toContain('line.bad variable y is unused');
  });

  it('rejects transforms that read children and duplicate property names', () => {
    expect(
      broken((m) => {
        m.line = {
          ...m.line,
          properties: [
            {
              kind: 'transform',
              name: 't',
              dataType: 'DOUBLE',
              expression: 'x + 1',
              variables: { x: { hierarchy: 'pumps', property: 'temperature_c' } },
            },
            { kind: 'attribute', name: 't', dataType: 'STRING', defaultValue: '' },
          ],
        };
      }),
    ).toEqual(
      expect.arrayContaining([
        'line: duplicate property t',
        'line.t variable x: transforms cannot read children',
      ]),
    );
  });
});

describe('assetExternalIdFor', () => {
  it('joins topology ids with dots', () => {
    expect(assetExternalIdFor('kochi-01', 'line-a', 'pump-01')).toBe('kochi-01.line-a.pump-01');
  });
});
