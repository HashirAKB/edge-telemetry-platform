/**
 * SRS 13.2 / FR-EDGE-4: change the running simulator's configuration with a Greengrass
 * deployment configuration merge, without rebuilding the image. Creates a new revision of the
 * thing group's deployment that keeps every component and only changes the simulator merge.
 *
 *   AWS_PROFILE=etp pnpm edge:fault bearingWear pump-02 600   # inject for 600 s
 *   AWS_PROFILE=etp pnpm edge:fault clear                      # back to defaults
 *
 * The next `cdk deploy EtpEdge` replaces this revision with the CDK-defined one.
 */
import {
  CreateDeploymentCommand,
  GetDeploymentCommand,
  GreengrassV2Client,
  ListDeploymentsCommand,
} from '@aws-sdk/client-greengrassv2';
import { FaultSpec } from '@etp/simulator';
import { awsContext, fail } from './lib/context.js';

const COMPONENT = 'com.hashirakb.etp.SensorSimulator';
const [kind, machineId, duration] = process.argv.slice(2).filter((a) => a !== '--');

const { region, account } = await awsContext();
const targetArn = `arn:aws:iot:${region}:${account}:thinggroup/etp-edge-cores`;
const gg = new GreengrassV2Client({ region });

const list = await gg.send(new ListDeploymentsCommand({ targetArn, historyFilter: 'LATEST_ONLY' }));
const latestId = list.deployments?.[0]?.deploymentId ?? fail('no deployment for etp-edge-cores');
const current = await gg.send(new GetDeploymentCommand({ deploymentId: latestId }));
const components = { ...(current.components ?? {}) };
const simulator = components[COMPONENT] ?? fail(`${COMPONENT} is not in the deployment`);

let faults: FaultSpec[] = [];
if (kind !== 'clear') {
  if (!kind || !machineId) fail('usage: edge:fault <kind> <machineId> [durationSec] | clear');
  // Validate locally with the same schema the simulator uses, so a typo never ships.
  faults = [
    FaultSpec.parse({ kind, machineId, startOffsetSec: 0, durationSec: Number(duration ?? 600) }),
  ];
}

components[COMPONENT] = {
  ...simulator,
  configurationUpdate: { merge: JSON.stringify({ simulator: { faults } }) },
};
const created = await gg.send(
  new CreateDeploymentCommand({
    targetArn,
    deploymentName: current.deploymentName,
    components,
    deploymentPolicies: current.deploymentPolicies,
  }),
);
console.log(
  `deployment ${created.deploymentId ?? '?'} created: ${kind === 'clear' ? 'faults cleared' : JSON.stringify(faults)}`,
);
