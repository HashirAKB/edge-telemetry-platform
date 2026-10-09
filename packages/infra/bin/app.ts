import { App } from 'aws-cdk-lib';
import { ApiStack } from '../src/stacks/api-stack.js';
import { EdgeHostStack } from '../src/stacks/edge-host-stack.js';
import { EdgeStack } from '../src/stacks/edge-stack.js';
import { FoundationStack } from '../src/stacks/foundation-stack.js';
import { IngestStack } from '../src/stacks/ingest-stack.js';
import { ObservabilityStack } from '../src/stacks/observability-stack.js';
import { SiteWiseStack } from '../src/stacks/sitewise-stack.js';
import { PROJECT_TAGS } from '../src/tags.js';

const app = new App();

// Account is resolved from the CLI credentials at deploy time; synth (and CI) needs none.
// The region is pinned (SRS 0.3), not taken from CDK_DEFAULT_REGION: that comes from whichever
// AWS profile is active and silently falls back to us-east-1, which would deploy elsewhere.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const env = {
  region: String(app.node.tryGetContext('region') ?? 'ap-south-1'),
  ...(account ? { account } : {}),
};
const common = { env, tags: { ...PROJECT_TAGS } };

const rawArchive = String(app.node.tryGetContext('rawArchive')) === 'true';

const foundation = new FoundationStack(app, 'EtpFoundation', common);
const sitewise = new SiteWiseStack(app, 'EtpSiteWise', common);
new IngestStack(app, 'EtpIngest', {
  ...common,
  machineAssetIds: sitewise.machineAssetIds,
  ruleErrorsLogGroup: foundation.ruleErrorsLogGroup,
  rawArchive,
});

const buildVersion = String(app.node.tryGetContext('buildVersion') ?? 'dev');
const api = new ApiStack(app, 'EtpApi', { ...common, buildVersion });

// Observability (SRS 6.6). The alert email is context, never committed (FR-OBS-3); with real
// credentials it is required, so a deploy cannot silently drop the subscription or the budget.
const alertEmail = app.node.tryGetContext('alertEmail') as string | undefined;
if (!alertEmail && account) {
  throw new Error('Pass the alert email: -c alertEmail=<address>');
}
new ObservabilityStack(app, 'EtpObservability', {
  ...common,
  alertsTopic: foundation.alertsTopic,
  ...(alertEmail ? { alertEmail } : {}),
  budgetUsd: Number(app.node.tryGetContext('budgetUsd') ?? 10),
  freshnessEnabled: String(app.node.tryGetContext('freshnessMonitor')) === 'on',
  apiName: 'etp-query-api',
  apiStage: 'live',
  apiFunctions: Object.values(api.functions),
});

// Greengrass edge (SRS 6.2). The image tag comes from scripts/publish-simulator-image.ts.
// Credential-free synth (CI) may use a placeholder; with real credentials (deploy, diff) a missing
// tag is an error, because a component pointing at a missing image only fails later, on the device.
const contextTag = app.node.tryGetContext('simulatorImageTag') as string | undefined;
if (!contextTag && account) {
  throw new Error(
    'Pass the simulator image tag: -c simulatorImageTag=<tag> (see pnpm edge:publish-image)',
  );
}
const imageTag = contextTag ?? 'unpublished';
const edge = new EdgeStack(app, 'EtpEdge', {
  ...common,
  repository: foundation.simulatorRepository,
  imageTag,
});

// FR-EDGE-6: the EC2 core host exists only when asked for, so it can be destroyed after demos.
if (String(app.node.tryGetContext('edgeHost')) === 'ec2') {
  const availabilityZone = String(app.node.tryGetContext('edgeAz') ?? 'ap-south-1b');
  const host = new EdgeHostStack(app, 'EtpEdgeHost', { ...common, availabilityZone });
  host.addStackDependency(edge);
}
