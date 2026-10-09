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
import { runOnInstance, stackOutputs } from './lib/aws.js';
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
  if ((installed.installedComponents ?? []).length === 0) {
    // Observed on a fresh core: HEALTHY and status updates published, but the cloud's installed
    // component list stays empty. Fall back to the lifecycle state the nucleus logs on the device.
    console.log('  (cloud reports no installed components; checking the device over SSM)');
    const { InstanceId } = await stackOutputs(region, 'EtpEdgeHost');
    if (InstanceId) {
      const state = await runOnInstance(
        region,
        InstanceId,
        `grep -h "serviceName=${COMPONENT}" /greengrass/v2/logs/greengrass.log | grep -o "newState=[A-Z_]*" | tail -1; docker ps --filter name=etp-sensor-simulator --format "{{.Status}}"`,
        60,
      );
      console.log(`  device: ${state.trim().replace(/\n/g, ', ')}`);
      running = state.includes('newState=RUNNING') && state.includes('Up ');
    }
  }
} catch (error) {
  console.log(`core ${THING} not registered yet: ${(error as Error).message}`);
}

console.log(`\n${healthy && running ? 'PASS' : 'FAIL'}  core HEALTHY and ${COMPONENT} RUNNING`);
process.exit(healthy && running ? 0 : 1);
