import { describe, expect, it } from 'vitest';
import { API_BASE_PATH } from './index.js';

describe('api placeholder', () => {
  it('versions the base path from the shared contract version', () => {
    expect(API_BASE_PATH).toBe('/v1');
  });
});
