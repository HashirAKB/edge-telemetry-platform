import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, PLATFORM_NAME } from './index.js';

describe('shared placeholder', () => {
  it('exports the platform name and contract version', () => {
    expect(PLATFORM_NAME).toBe('edge-telemetry-platform');
    expect(CONTRACT_VERSION).toBe(1);
  });
});
