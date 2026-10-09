/**
 * Removes what the Greengrass installer created outside CloudFormation (the core device, its
 * AWS IoT thing and certificate, and the installer's TES certificate policy). Run after
 * destroying EtpEdgeHost and before destroying EtpEdge. Safe to re-run.
 *
 *   AWS_PROFILE=etp pnpm edge:deprovision
 */
import { DeleteCoreDeviceCommand, GreengrassV2Client } from '@aws-sdk/client-greengrassv2';
import {
  DeleteCertificateCommand,
  DeletePolicyCommand,
  DeleteThingCommand,
  DetachPolicyCommand,
  DetachThingPrincipalCommand,
  IoTClient,
  ListAttachedPoliciesCommand,
  ListThingPrincipalsCommand,
  UpdateCertificateCommand,
} from '@aws-sdk/client-iot';
import { awsContext, isAwsError } from './lib/context.js';

const THING = 'etp-edge-core-01';
const INSTALLER_POLICY = 'GreengrassTESCertificatePolicyetp-edge-tes-alias';

const { region } = await awsContext();
const iot = new IoTClient({ region });

async function step(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    console.log(`ok    ${label}`);
  } catch (error) {
    if (isAwsError(error, 'ResourceNotFoundException')) console.log(`skip  ${label} (not found)`);
    else throw error;
  }
}

await step('delete Greengrass core device', () =>
  new GreengrassV2Client({ region }).send(
    new DeleteCoreDeviceCommand({ coreDeviceThingName: THING }),
  ),
);

let principals: string[] = [];
try {
  principals =
    (await iot.send(new ListThingPrincipalsCommand({ thingName: THING }))).principals ?? [];
} catch (error) {
  if (!isAwsError(error, 'ResourceNotFoundException')) throw error;
}
for (const cert of principals) {
  const certificateId = cert.split('/').pop() ?? '';
  const attached =
    (await iot.send(new ListAttachedPoliciesCommand({ target: cert }))).policies ?? [];
  for (const policy of attached) {
    await step(`detach ${policy.policyName ?? ''}`, () =>
      iot.send(new DetachPolicyCommand({ policyName: policy.policyName, target: cert })),
    );
  }
  await step('detach certificate', () =>
    iot.send(new DetachThingPrincipalCommand({ thingName: THING, principal: cert })),
  );
  await step('deactivate certificate', () =>
    iot.send(new UpdateCertificateCommand({ certificateId, newStatus: 'INACTIVE' })),
  );
  await step('delete certificate', () => iot.send(new DeleteCertificateCommand({ certificateId })));
}
await step(`delete thing ${THING}`, () => iot.send(new DeleteThingCommand({ thingName: THING })));
await step(`delete installer policy ${INSTALLER_POLICY}`, () =>
  iot.send(new DeletePolicyCommand({ policyName: INSTALLER_POLICY })),
);
