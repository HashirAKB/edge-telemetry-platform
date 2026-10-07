import { describe, expect, it } from 'vitest';
import { telemetryTopicPrefix } from './index.js';

describe('simulator placeholder', () => {
  it('builds the topic prefix from the shared contract version', () => {
    expect(telemetryTopicPrefix()).toBe('telemetry/v1');
  });
});
