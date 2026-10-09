import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const file = (content: unknown) => () => JSON.stringify(content);

describe('loadConfig (FR-SIM-6)', () => {
  it('defaults to every topology machine, 5 s interval, stdout', () => {
    const config = loadConfig({});
    expect(config.devices.map((d) => d.machineId)).toEqual([
      'pump-01',
      'pump-02',
      'comp-01',
      'pump-03',
      'comp-02',
    ]);
    expect(config).toMatchObject({ intervalMs: 5_000, transport: 'stdout', seed: 42, faults: [] });
  });

  it('layers file settings under environment variables', () => {
    const config = loadConfig(
      { CONFIG_FILE: 'sim.json', INTERVAL_MS: '1000', SEED: '7', LOG_LEVEL: 'debug' },
      file({
        intervalMs: 2_000,
        bufferMax: 10,
        faults: [{ kind: 'dropout', machineId: 'pump-01', startOffsetSec: 0, durationSec: 30 }],
      }),
    );
    expect(config).toMatchObject({ intervalMs: 1_000, seed: 7, bufferMax: 10, logLevel: 'debug' });
    expect(config.faults).toHaveLength(1);
  });

  it('builds mqtt settings from the environment', () => {
    const config = loadConfig({
      TRANSPORT: 'mqtt',
      IOT_ENDPOINT: 'abc-ats.iot.ap-south-1.amazonaws.com',
      CERT_PATH: '.certs/dev.crt',
      KEY_PATH: '.certs/dev.key',
      CLIENT_ID: 'etp-dev-device',
      CA_PATH: '/app/AmazonRootCA1.pem',
    });
    expect(config.mqtt?.clientId).toBe('etp-dev-device');
    expect(config.mqtt?.caPath).toBe('/app/AmazonRootCA1.pem');
  });

  it('ignores CA_PATH on its own, as set in the container image', () => {
    const config = loadConfig({ CA_PATH: '/app/AmazonRootCA1.pem' });
    expect(config.transport).toBe('stdout');
    expect(config.mqtt).toBeUndefined();
  });

  it.each([
    ['mqtt without settings', { TRANSPORT: 'mqtt' }, /IOT_ENDPOINT/],
    ['unknown transport', { TRANSPORT: 'carrier-pigeon' }, /transport/],
    ['non-numeric interval', { INTERVAL_MS: 'fast' }, /intervalMs/],
    ['interval too short', { INTERVAL_MS: '10' }, /intervalMs/],
  ])('rejects %s', (_case, env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });

  it.each([
    [
      'a fault for an unknown machine',
      { faults: [{ kind: 'dropout', machineId: 'pump-99', startOffsetSec: 0, durationSec: 1 }] },
      /unknown machineId "pump-99"/,
    ],
    [
      'a stuck sensor on a measurement the machine lacks',
      {
        faults: [
          {
            kind: 'stuckSensor',
            machineId: 'comp-01',
            measurement: 'flow_lpm',
            startOffsetSec: 0,
            durationSec: 1,
          },
        ],
      },
      /"flow_lpm" is not a compressor measurement/,
    ],
    [
      'an idle window for an unknown machine',
      { idleWindows: [{ machineId: 'x-1', startOffsetSec: 0, durationSec: 1 }] },
      /unknown machineId "x-1"/,
    ],
    [
      'duplicate devices',
      {
        devices: [
          { siteId: 's', lineId: 'l', machineId: 'm', type: 'pump' },
          { siteId: 's', lineId: 'l', machineId: 'm', type: 'pump' },
        ],
      },
      /duplicate machineId/,
    ],
    ['an unknown key', { intervalMS: 1000 }, /intervalMS/],
  ])('rejects %s', (_case, content, message) => {
    expect(() => loadConfig({ CONFIG_FILE: 'x.json' }, file(content))).toThrow(message);
  });

  it('reports an unreadable config file clearly', () => {
    expect(() =>
      loadConfig({ CONFIG_FILE: 'missing.json' }, () => {
        throw new Error('ENOENT');
      }),
    ).toThrow(/Cannot read CONFIG_FILE missing.json: ENOENT/);
  });

  it('layers Greengrass component configuration between the file and the environment', () => {
    const config = loadConfig(
      { CONFIG_FILE: 'sim.json', INTERVAL_MS: '2000' },
      file({ intervalMs: 9_000, seed: 3, bufferMax: 7 }),
      {
        intervalMs: 4_000,
        seed: 5,
        faults: [
          { kind: 'bearingWear', machineId: 'pump-02', startOffsetSec: 0, durationSec: 600 },
        ],
      },
    );
    expect(config).toMatchObject({ intervalMs: 2_000, seed: 5, bufferMax: 7 });
    expect(config.faults[0]).toMatchObject({ kind: 'bearingWear', machineId: 'pump-02' });
  });

  it('rejects an invalid Greengrass configuration with a readable error', () => {
    expect(() => loadConfig({}, undefined, { intervalMs: 'often' })).toThrow(/intervalMs/);
    expect(loadConfig({}, undefined, 'not an object').intervalMs).toBe(5_000);
  });
});
