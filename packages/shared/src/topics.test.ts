import { describe, expect, it } from 'vitest';
import { aliasFor } from './aliases.js';
import { measurementNamesFor } from './measurements.js';
import {
  PUBLISH_TOPIC_FILTER,
  ruleAliasTemplate,
  ruleSqlForType,
  TOPIC_SEGMENT,
  topicFilterForType,
  topicFor,
} from './topics.js';
import { listMachines } from './topology.js';
import { firstMachine } from './test-helpers.js';

/** Evaluate `${topic(n)}` the way AWS IoT rules do: 1-based segments of the topic. */
function substituteTopic(template: string, topic: string): string {
  const segments = topic.split('/');
  return template.replace(/\$\{topic\((\d+)\)\}/g, (_m, n: string) => {
    const segment = segments[Number(n) - 1];
    if (segment === undefined) throw new Error(`topic(${n}) out of range for ${topic}`);
    return segment;
  });
}

/** MQTT filter matching: `+` is one segment, `#` is the rest. */
function matchesFilter(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

describe('topics', () => {
  it('builds the SRS 5.1 topic', () => {
    expect(topicFor(firstMachine())).toBe('telemetry/v1/kochi-01/line-a/pump/pump-01');
  });

  it('places segments where IoT SQL topic(n) expects them', () => {
    const pump = firstMachine();
    const segments = topicFor(pump).split('/');
    expect(segments[TOPIC_SEGMENT.site - 1]).toBe(pump.siteId);
    expect(segments[TOPIC_SEGMENT.line - 1]).toBe(pump.lineId);
    expect(segments[TOPIC_SEGMENT.machineType - 1]).toBe(pump.type);
    expect(segments[TOPIC_SEGMENT.machine - 1]).toBe(pump.machineId);
  });

  it('builds the FR-ING-1 rule SQL', () => {
    expect(ruleSqlForType('pump')).toBe("SELECT * FROM 'telemetry/v1/+/+/pump/+'");
    expect(ruleSqlForType('compressor')).toBe("SELECT * FROM 'telemetry/v1/+/+/compressor/+'");
  });

  it("routes every machine to its own type's rule and no other", () => {
    for (const machine of listMachines()) {
      const topic = topicFor(machine);
      expect(matchesFilter(topicFilterForType(machine.type), topic)).toBe(true);
      const other = machine.type === 'pump' ? 'compressor' : 'pump';
      expect(matchesFilter(topicFilterForType(other), topic)).toBe(false);
      expect(matchesFilter(PUBLISH_TOPIC_FILTER, topic)).toBe(true);
    }
  });

  it('rule alias templates resolve to exactly the aliases set on SiteWise properties', () => {
    for (const machine of listMachines()) {
      for (const measurement of measurementNamesFor(machine.type)) {
        expect(substituteTopic(ruleAliasTemplate(measurement), topicFor(machine))).toBe(
          aliasFor(machine.siteId, machine.lineId, machine.machineId, measurement),
        );
      }
    }
  });

  it('writes the template in IoT substitution syntax', () => {
    expect(ruleAliasTemplate('temperature_c')).toBe(
      '/${topic(3)}/${topic(4)}/${topic(6)}/temperature_c',
    );
    expect(() => ruleAliasTemplate('bad name')).toThrow(/Invalid measurement/);
  });
});
