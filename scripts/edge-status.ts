/**
 * Phase 6 acceptance: core device HEALTHY and the simulator component RUNNING.
 *
 *   AWS_PROFILE=etp pnpm edge:status
 */
import {
  GetCoreDeviceCommand,
  GreengrassV2Client,
  ListInstalledComponentsCommand,
} from '@aws-sdk/client-greengrassv2';
import { awsContext } from './lib/context.js';

const THING = 'etp-edge-core-01';
const COMPONENT = 'com.hashirakb.etp.SensorSimulator';

const { region } = await awsContext();
const gg = new GreengrassV2Client({ region });

let healthy = false;
let running = false;
try {
  const core = await gg.send(new GetCoreDeviceCommand({ coreDeviceThingName: THING }));
  healthy = core.status === 'HEALTHY';
  console.log(
    `core ${THING}: ${core.status ?? '?'} (nucleus ${core.coreVersion ?? '?'}, last status ${core.lastStatusUpdateTimestamp?.toISOString() ?? '?'})`,
  );
  const installed = await gg.send(
    new ListInstalledComponentsCommand({ coreDeviceThingName: THING }),
  );
  for (const c of installed.installedComponents ?? []) {
    console.log(
      `  ${(c.componentName ?? '').padEnd(42)} ${(c.componentVersion ?? '').padEnd(14)} ${c.lifecycleState ?? ''}`,
    );
    if (c.componentName === COMPONENT) running = c.lifecycleState === 'RUNNING';
  }
} catch (error) {
  console.log(`core ${THING} not registered yet: ${(error as Error).message}`);
}

console.log(`\n${healthy && running ? 'PASS' : 'FAIL'}  core HEALTHY and ${COMPONENT} RUNNING`);
process.exit(healthy && running ? 0 : 1);
