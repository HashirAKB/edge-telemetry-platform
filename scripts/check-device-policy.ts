/**
 * SRS 13.4: proves the dev device policy is least-privilege by trying things it must not do.
 *   1. publish to an allowed telemetry topic           -> accepted
 *   2. publish outside telemetry/v1/                   -> rejected by the broker
 *   3. connect with a client ID other than the thing's -> refused
 *
 *   AWS_PROFILE=etp pnpm device:check-policy   (after pnpm device:provision)
 */
import { existsSync, readFileSync } from 'node:fs';
import { listMachines } from '@etp/shared';
import { createLogger, MachineSimulator, MqttTransport } from '@etp/simulator';
import { devDevicePaths, fail } from './lib/context.js';

if (!existsSync(devDevicePaths.env)) fail('No dev device. Run pnpm device:provision first.');
const env = Object.fromEntries(
  readFileSync(devDevicePaths.env, 'utf8')
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
) as Record<string, string>;

const settings = {
  endpoint: env.IOT_ENDPOINT ?? '',
  certPath: env.CERT_PATH ?? '',
  keyPath: env.KEY_PATH ?? '',
  clientId: env.CLIENT_ID ?? '',
};
const logger = createLogger('warn');
let failures = 0;

function report(ok: boolean, label: string, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${detail}`);
  if (!ok) failures += 1;
}

const transport = new MqttTransport({ settings, logger, publishTimeoutMs: 10_000 });
await transport.connect();

const [machine] = listMachines();
if (!machine) fail('topology has no machines');
const sample = new MachineSimulator({ machine, seed: 1, startedAtMs: Date.now() }).sample(
  Date.now(),
);
if (!sample) fail('could not generate a sample message');
try {
  await transport.publish(sample.topic, JSON.stringify(sample.message));
  report(true, 'allowed topic', `${sample.topic} accepted`);
} catch (error) {
  report(false, 'allowed topic', (error as Error).message);
}

try {
  await transport.publish('etp/forbidden/test', '{}');
  report(false, 'forbidden topic', 'etp/forbidden/test was accepted');
} catch (error) {
  report(true, 'forbidden topic', `rejected (${(error as Error).message})`);
}
await transport.close();

const impostor = new MqttTransport({
  settings: { ...settings, clientId: 'etp-impostor' },
  logger,
  connectTimeoutMs: 15_000,
});
try {
  await impostor.connect();
  report(false, 'other client ID', 'connected as etp-impostor');
  await impostor.close();
} catch (error) {
  report(true, 'other client ID', `refused (${(error as Error).message.slice(0, 120)})`);
}

process.exit(failures > 0 ? 1 : 0);
