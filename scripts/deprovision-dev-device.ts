/**
 * Removes everything provision-dev-device created: certificate (deactivated, then deleted),
 * policy, thing, and the local files in .certs/. Safe to re-run.
 *
 *   AWS_PROFILE=etp pnpm device:deprovision
 */
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import {
  DeleteCertificateCommand,
  DeletePolicyCommand,
  DeleteThingCommand,
  DetachPolicyCommand,
  DetachThingPrincipalCommand,
  IoTClient,
  ListThingPrincipalsCommand,
  UpdateCertificateCommand,
} from '@aws-sdk/client-iot';
import {
  awsContext,
  DEV_POLICY_NAME,
  DEV_THING_NAME,
  devDevicePaths as paths,
  isAwsError,
} from './lib/context.js';

const { region } = await awsContext();
const iot = new IoTClient({ region });

async function step(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    console.log(`ok    ${label}`);
  } catch (error) {
    if (isAwsError(error, 'ResourceNotFoundException')) {
      console.log(`skip  ${label} (not found)`);
      return;
    }
    throw error;
  }
}

// Prefer the recorded certificate; fall back to whatever is attached to the thing.
let certificateArns: string[] = [];
if (existsSync(paths.state)) {
  const state = JSON.parse(await readFile(paths.state, 'utf8')) as { certificateArn: string };
  certificateArns = [state.certificateArn];
} else {
  try {
    const listed = await iot.send(new ListThingPrincipalsCommand({ thingName: DEV_THING_NAME }));
    certificateArns = listed.principals ?? [];
  } catch (error) {
    if (!isAwsError(error, 'ResourceNotFoundException')) throw error;
  }
}

for (const arn of certificateArns) {
  const certificateId = arn.split('/').pop() ?? '';
  await step('detach certificate from thing', () =>
    iot.send(new DetachThingPrincipalCommand({ thingName: DEV_THING_NAME, principal: arn })),
  );
  await step('detach policy from certificate', () =>
    iot.send(new DetachPolicyCommand({ policyName: DEV_POLICY_NAME, target: arn })),
  );
  await step('deactivate certificate', () =>
    iot.send(new UpdateCertificateCommand({ certificateId, newStatus: 'INACTIVE' })),
  );
  await step('delete certificate', () => iot.send(new DeleteCertificateCommand({ certificateId })));
}
await step(`delete policy ${DEV_POLICY_NAME}`, () =>
  iot.send(new DeletePolicyCommand({ policyName: DEV_POLICY_NAME })),
);
await step(`delete thing ${DEV_THING_NAME}`, () =>
  iot.send(new DeleteThingCommand({ thingName: DEV_THING_NAME })),
);

for (const file of Object.values(paths)) await rm(file, { force: true });
console.log('ok    removed local key, certificate, and env files');
