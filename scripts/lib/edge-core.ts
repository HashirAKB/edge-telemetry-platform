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
import { isAwsError } from './context.js';

export const EDGE_CORE_THING = 'etp-edge-core-01';
export const INSTALLER_POLICY = 'GreengrassTESCertificatePolicyetp-edge-tes-alias';

async function step(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    console.log(`ok    ${label}`);
  } catch (error) {
    if (isAwsError(error, 'ResourceNotFoundException')) console.log(`skip  ${label} (not found)`);
    else throw error;
  }
}

/**
 * Removes what the Greengrass installer created outside CloudFormation (ADR 0014): the core
 * device, its AWS IoT thing and certificate, and the installer's TES certificate policy.
 * Safe to re-run: anything already gone is skipped.
 */
export async function deprovisionEdgeCore(region: string): Promise<void> {
  const iot = new IoTClient({ region });
  await step('delete Greengrass core device', () =>
    new GreengrassV2Client({ region }).send(
      new DeleteCoreDeviceCommand({ coreDeviceThingName: EDGE_CORE_THING }),
    ),
  );

  let principals: string[] = [];
  try {
    principals =
      (await iot.send(new ListThingPrincipalsCommand({ thingName: EDGE_CORE_THING }))).principals ??
      [];
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
      iot.send(new DetachThingPrincipalCommand({ thingName: EDGE_CORE_THING, principal: cert })),
    );
    await step('deactivate certificate', () =>
      iot.send(new UpdateCertificateCommand({ certificateId, newStatus: 'INACTIVE' })),
    );
    await step('delete certificate', () =>
      iot.send(new DeleteCertificateCommand({ certificateId })),
    );
  }
  await step(`delete thing ${EDGE_CORE_THING}`, () =>
    iot.send(new DeleteThingCommand({ thingName: EDGE_CORE_THING })),
  );
  await step(`delete installer policy ${INSTALLER_POLICY}`, () =>
    iot.send(new DeletePolicyCommand({ policyName: INSTALLER_POLICY })),
  );
}
