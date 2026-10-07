import { describe, expect, it } from 'vitest';
import { AssetByKeyParams, AssetTreeResponse, externalKeyFor } from './assets.js';
import { Problem } from './common.js';

const uuid = (n: number) => `3f8e1d6a-2b4c-4d5e-8f60-${n.toString().padStart(12, '0')}`;

const property = {
  propertyId: uuid(100),
  name: 'temperature_c',
  kind: 'measurement',
  unit: 'Celsius',
  dataType: 'DOUBLE',
  alias: '/kochi-01/line-a/pump-01/temperature_c',
};

describe('AssetTreeResponse (FR-API-1)', () => {
  it('validates a nested site, line, machine tree', () => {
    const tree = {
      generatedAt: '2026-10-07T10:00:00Z',
      site: {
        assetId: uuid(1),
        externalKey: 'kochi-01',
        name: 'Kochi Plant 01',
        type: 'site',
        properties: [],
        children: [
          {
            assetId: uuid(2),
            externalKey: 'kochi-01/line-a',
            name: 'Line A',
            type: 'line',
            properties: [],
            children: [
              {
                assetId: uuid(3),
                externalKey: 'kochi-01/line-a/pump-01',
                name: 'pump-01',
                type: 'pump',
                properties: [property],
                children: [],
              },
            ],
          },
        ],
      },
    };
    expect(AssetTreeResponse.parse(tree)).toEqual(tree);
  });

  it('rejects an invalid node deep in the tree', () => {
    const tree = {
      generatedAt: '2026-10-07T10:00:00Z',
      site: {
        assetId: uuid(1),
        externalKey: 'kochi-01',
        name: 'Site',
        type: 'site',
        properties: [],
        children: [
          {
            assetId: 'not-a-uuid',
            externalKey: 'x',
            name: 'x',
            type: 'line',
            properties: [],
            children: [],
          },
        ],
      },
    };
    expect(AssetTreeResponse.safeParse(tree).success).toBe(false);
  });
});

describe('AssetByKeyParams (FR-API-3)', () => {
  it('accepts topology ids and rejects anything else', () => {
    expect(
      AssetByKeyParams.safeParse({ siteId: 'kochi-01', lineId: 'line-a', machineId: 'pump-01' })
        .success,
    ).toBe(true);
    expect(
      AssetByKeyParams.safeParse({ siteId: 'kochi-01', lineId: '..', machineId: 'pump-01' })
        .success,
    ).toBe(false);
  });
});

describe('externalKeyFor', () => {
  it('joins topology ids with slashes', () => {
    expect(externalKeyFor('kochi-01', 'line-a', 'pump-01')).toBe('kochi-01/line-a/pump-01');
  });
});

describe('Problem (RFC 7807)', () => {
  it('defaults type to about:blank', () => {
    expect(Problem.parse({ title: 'Not Found', status: 404 }).type).toBe('about:blank');
  });

  it('only allows error status codes', () => {
    expect(Problem.safeParse({ title: 'OK', status: 200 }).success).toBe(false);
  });
});
