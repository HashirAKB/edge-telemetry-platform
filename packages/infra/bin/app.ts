import { App } from 'aws-cdk-lib';
import { ApiStack } from '../src/stacks/api-stack.js';
import { EdgeHostStack } from '../src/stacks/edge-host-stack.js';
import { EdgeStack } from '../src/stacks/edge-stack.js';
import { FoundationStack } from '../src/stacks/foundation-stack.js';
import { IngestStack } from '../src/stacks/ingest-stack.js';
import { SiteWiseStack } from '../src/stacks/sitewise-stack.js';
import { PROJECT_TAGS } from '../src/tags.js';

const app = new App();

// Account is resolved from the CLI credentials at deploy time; synth (and CI) needs none.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const env = {
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-south-1',
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
new ApiStack(app, 'EtpApi', { ...common, buildVersion });

// Greengrass edge (SRS 6.2). The image tag comes from scripts/publish-simulator-image.ts;
// "unpublished" lets CI synthesize without one (a deploy with it would fail on the device).
const imageTag = String(app.node.tryGetContext('simulatorImageTag') ?? 'unpublished');
const edge = new EdgeStack(app, 'EtpEdge', {
  ...common,
  repository: foundation.simulatorRepository,
  imageTag,
});

// FR-EDGE-6: the EC2 core host exists only when asked for, so it can be destroyed after demos.
if (String(app.node.tryGetContext('edgeHost')) === 'ec2') {
  const host = new EdgeHostStack(app, 'EtpEdgeHost', common);
  host.addStackDependency(edge);
}
