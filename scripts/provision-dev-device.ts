/**
 * FR-DX-3: create a dev IoT thing, certificate, and least-privilege policy for running the
 * simulator with TRANSPORT=mqtt from a laptop. Keys go to .certs/ (gitignored) and are never
 * printed. Remove everything with `pnpm device:deprovision`.
 *
 *   AWS_PROFILE=etp pnpm device:provision
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import {
  AttachPolicyCommand,
  AttachThingPrincipalCommand,
  CreateKeysAndCertificateCommand,
  CreatePolicyCommand,
  CreateThingCommand,
  DescribeEndpointCommand,
  IoTClient,
} from '@aws-sdk/client-iot';
import { TOPIC_PREFIX } from '@etp/shared';
import {
  awsContext,
  CERTS_DIR,
  DEV_POLICY_NAME,
  DEV_THING_NAME,
  devDevicePaths as paths,
  fail,
} from './lib/context.js';

const { region, account } = await awsContext();
if (existsSync(paths.state)) {
  fail(`${paths.state} exists: already provisioned. Run pnpm device:deprovision first.`);
}

const iot = new IoTClient({ region });
await mkdir(CERTS_DIR, { recursive: true, mode: 0o700 });

await iot.send(new CreateThingCommand({ thingName: DEV_THING_NAME }));
console.log(`thing ${DEV_THING_NAME} ready`);

const keys = await iot.send(new CreateKeysAndCertificateCommand({ setAsActive: true }));
const { certificateArn, certificateId, certificatePem, keyPair } = keys;
if (!certificateArn || !certificateId || !certificatePem || !keyPair?.PrivateKey) {
  fail('CreateKeysAndCertificate returned an incomplete response');
}
// Record what exists first, so deprovision can clean up even if a later step fails.
await writeFile(
  paths.state,
  JSON.stringify(
    { thingName: DEV_THING_NAME, certificateArn, certificateId, policyName: DEV_POLICY_NAME },
    null,
    2,
  ),
);
await writeFile(paths.privateKey, keyPair.PrivateKey, { mode: 0o600 });
await chmod(paths.privateKey, 0o600);
await writeFile(paths.certificate, certificatePem, { mode: 0o644 });
console.log(
  `certificate ${certificateId.slice(0, 12)}... created, key written to .certs/ (mode 600)`,
);

// Least privilege (NFR-4): connect only as this thing, publish only under telemetry/v1/.
const policyDocument = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Action: 'iot:Connect',
      Resource: `arn:aws:iot:${region}:${account}:client/${DEV_THING_NAME}`,
    },
    {
      Effect: 'Allow',
      Action: 'iot:Publish',
      Resource: `arn:aws:iot:${region}:${account}:topic/${TOPIC_PREFIX}/*`,
    },
  ],
};
await iot.send(
  new CreatePolicyCommand({
    policyName: DEV_POLICY_NAME,
    policyDocument: JSON.stringify(policyDocument),
  }),
);
await iot.send(new AttachPolicyCommand({ policyName: DEV_POLICY_NAME, target: certificateArn }));
await iot.send(
  new AttachThingPrincipalCommand({ thingName: DEV_THING_NAME, principal: certificateArn }),
);
console.log(`policy ${DEV_POLICY_NAME} attached`);

const { endpointAddress } = await iot.send(
  new DescribeEndpointCommand({ endpointType: 'iot:Data-ATS' }),
);
if (!endpointAddress) fail('DescribeEndpoint returned no address');

await writeFile(
  paths.env,
  [
    'TRANSPORT=mqtt',
    `IOT_ENDPOINT=${endpointAddress}`,
    `CERT_PATH=${paths.certificate}`,
    `KEY_PATH=${paths.privateKey}`,
    `CLIENT_ID=${DEV_THING_NAME}`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);

console.log(`\nDone. Run the simulator against AWS IoT Core with:
  set -a && . .certs/${DEV_THING_NAME}.env && set +a && pnpm sim:local`);
