import { describe, expect, it } from 'vitest';
import { assertId, Id } from './ids.js';

describe('Id', () => {
  it.each(['kochi-01', 'a', 'line-a', '01'])('accepts %j', (id) => {
    expect(Id.safeParse(id).success).toBe(true);
  });

  it('names the failing field in assertId errors', () => {
    expect(() => {
      assertId('Bad', 'siteId');
    }).toThrow(/Invalid siteId "Bad"/);
    expect(() => {
      assertId('ok-1', 'siteId');
    }).not.toThrow();
  });
});
