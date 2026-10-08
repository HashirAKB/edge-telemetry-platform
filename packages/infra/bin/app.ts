import { App } from 'aws-cdk-lib';
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
