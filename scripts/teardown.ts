/**
 * Removes the whole platform in dependency order (FR-DX-5, NFR-8) and then lists what is left.
 *
 *   AWS_PROFILE=etp pnpm teardown --dry-run   # show the plan and what exists; change nothing
 *   AWS_PROFILE=etp pnpm teardown             # asks you to type the account ID, then deletes
 *
 * Deletes the CloudFormation stacks directly (what `cdk destroy` does), so it needs no CDK
 * context such as the image tag or alert email. Order:
 *   1. EtpObservability first, so no stale alarm emails fire while the edge goes away
 *   2. EtpEdgeHost (the EC2 core), then the installer-created thing and certificate (ADR 0014)
 *   3. EtpEdge, EtpApi, EtpIngest (imports SiteWise and Foundation), EtpSiteWise, EtpFoundation
 *   4. Log groups that CDK's own custom resources left outside CloudFormation
 */
import { createInterface } from 'node:readline/promises';
import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
  waitUntilStackDeleteComplete,
} from '@aws-sdk/client-cloudformation';
import {
  CloudWatchLogsClient,
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { GreengrassV2Client, ListCoreDevicesCommand } from '@aws-sdk/client-greengrassv2';
import { IoTClient, ListThingsCommand } from '@aws-sdk/client-iot';
import { IoTSiteWiseClient, ListAssetModelsCommand } from '@aws-sdk/client-iotsitewise';
import { awsContext, fail, isAwsError } from './lib/context.js';
import { deprovisionEdgeCore } from './lib/edge-core.js';

const STACKS = [
  'EtpObservability',
  'EtpEdgeHost',
  'EtpEdge',
  'EtpApi',
  'EtpIngest',
  'EtpSiteWise',
  'EtpFoundation',
] as const;
const DELETE_TIMEOUT_SECONDS = 30 * 60;

const dryRun = process.argv.includes('--dry-run');
const { region, account } = await awsContext();
const cfn = new CloudFormationClient({ region });

async function stackStatus(name: string): Promise<string | undefined> {
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: name }));
    return out.Stacks?.[0]?.StackStatus;
  } catch (error) {
    // A stack that does not exist is reported as a ValidationError.
    if (isAwsError(error, 'ValidationError')) return undefined;
    throw error;
  }
}

async function destroyStack(name: string): Promise<void> {
  if (!(await stackStatus(name))) {
    console.log(`skip  ${name} (not deployed)`);
    return;
  }
  console.log(`...   deleting ${name}`);
  await cfn.send(new DeleteStackCommand({ StackName: name }));
  try {
    await waitUntilStackDeleteComplete(
      { client: cfn, maxWaitTime: DELETE_TIMEOUT_SECONDS },
      { StackName: name },
    );
  } catch {
    fail(`${name} did not delete cleanly (${(await stackStatus(name)) ?? '?'}); see the console`);
  }
  console.log(`ok    ${name} deleted`);
}

/** What still exists in the account that this project created (empty after a clean teardown). */
async function leftovers(): Promise<string[]> {
  const found: string[] = [];
  for (const name of STACKS) {
    const status = await stackStatus(name);
    if (status) found.push(`stack ${name} (${status})`);
  }
  const things = await new IoTClient({ region }).send(new ListThingsCommand({}));
  for (const t of things.things ?? []) {
    if (t.thingName?.startsWith('etp-')) found.push(`IoT thing ${t.thingName}`);
  }
  const cores = await new GreengrassV2Client({ region }).send(new ListCoreDevicesCommand({}));
  for (const c of cores.coreDevices ?? []) {
    if (c.coreDeviceThingName?.startsWith('etp-')) {
      found.push(`Greengrass core device ${c.coreDeviceThingName}`);
    }
  }
  const models = await new IoTSiteWiseClient({ region }).send(new ListAssetModelsCommand({}));
  for (const m of models.assetModelSummaries ?? []) {
    if (m.name?.startsWith('etp-')) found.push(`SiteWise asset model ${m.name}`);
  }
  for (const prefix of [ORPHAN_LOG_PREFIX, '/etp/']) {
    for (const name of await logGroups(prefix)) found.push(`log group ${name}`);
  }
  return found;
}

/**
 * Our own log groups are stack resources and go with their stacks. CDK's built-in custom resource
 * Lambdas (such as the one that locks down the VPC's default security group) log to groups that
 * CloudFormation does not manage, one per deploy, with no expiry; teardown deletes those too.
 */
const ORPHAN_LOG_PREFIX = '/aws/lambda/Etp';
const logs = new CloudWatchLogsClient({ region });

async function logGroups(prefix: string): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const out = await logs.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken }),
    );
    names.push(...(out.logGroups ?? []).map((g) => g.logGroupName ?? ''));
    nextToken = out.nextToken;
  } while (nextToken);
  return names;
}

const NOT_MANAGED = [
  'CDKToolkit stack (CDK bootstrap: an S3 bucket and ECR repository for deploy assets, cents per month). Keep it to redeploy; delete it and its bucket from the console if you are done for good.',
  'Budgets you created by hand (for example a zero-spend budget). The etp-monthly budget is part of EtpObservability.',
  'X-Ray traces and custom CloudWatch metrics expire on their own and are not billed once nothing publishes.',
  'The local dev certificate in .certs/, if you still have one: run pnpm device:deprovision.',
];

console.log(`\nTeardown plan for account ${account} in ${region}:`);
for (const [i, name] of STACKS.entries()) {
  const status = (await stackStatus(name)) ?? 'not deployed';
  console.log(`  ${String(i + 1)}. ${name.padEnd(17)} ${status}`);
  if (name === 'EtpEdgeHost')
    console.log('     then: core device, thing, certificate (edge:deprovision)');
}
console.log(`  ${String(STACKS.length + 1)}. log groups under ${ORPHAN_LOG_PREFIX} left by CDK`);

if (dryRun) {
  const present = await leftovers();
  console.log('\nProject resources that exist now:');
  for (const item of present) console.log(`  - ${item}`);
  console.log('\nNot managed by this script:');
  for (const note of NOT_MANAGED) console.log(`  - ${note}`);
  console.log('\nDry run: nothing was changed.');
  process.exit(0);
}

if (!process.stdin.isTTY) fail('teardown asks for confirmation; run it in a terminal');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`\nType the account ID (${account}) to delete everything: `);
rl.close();
if (answer.trim() !== account) fail('confirmation did not match; nothing was changed');

for (const name of STACKS) {
  await destroyStack(name);
  if (name === 'EtpEdgeHost') await deprovisionEdgeCore(region);
}
for (const name of await logGroups(ORPHAN_LOG_PREFIX)) {
  await logs.send(new DeleteLogGroupCommand({ logGroupName: name }));
  console.log(`ok    log group ${name} deleted`);
}

const remaining = await leftovers();
console.log('\nLeft behind by this project:');
if (remaining.length === 0) console.log('  - nothing');
for (const item of remaining) console.log(`  - ${item}`);
console.log('\nNot managed by this script:');
for (const note of NOT_MANAGED) console.log(`  - ${note}`);
