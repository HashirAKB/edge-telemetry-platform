import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { App, type Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { aliasFor, listMachines, measurementNamesFor, topology, type Topology } from '@etp/shared';
import { ApiStack, USAGE_PLAN } from '../src/stacks/api-stack.js';
import { EdgeHostStack } from '../src/stacks/edge-host-stack.js';
import {
  DASHBOARD_NAME,
  FRESHNESS_SCHEDULE,
  ObservabilityStack,
} from '../src/stacks/observability-stack.js';
import {
  EDGE,
  EdgeStack,
  GREENGRASS_VERSIONS,
  NUCLEUS_JVM_OPTIONS,
  SPOOLER_MAX_BYTES,
  simulatorRecipe,
} from '../src/stacks/edge-stack.js';
import { FoundationStack, RULE_ERRORS_LOG_GROUP } from '../src/stacks/foundation-stack.js';
import { IngestStack, ruleNameFor } from '../src/stacks/ingest-stack.js';
import { SiteWiseStack } from '../src/stacks/sitewise-stack.js';
import { PROJECT_TAGS } from '../src/tags.js';

interface Resource {
  Type: string;
  Properties: Record<string, unknown>;
}

function synth(
  options: {
    plant?: Topology;
    rawArchive?: boolean;
    imageTag?: string;
    alertEmail?: string | null;
    freshnessEnabled?: boolean;
  } = {},
) {
  const app = new App();
  const common = { tags: { ...PROJECT_TAGS } };
  const foundation = new FoundationStack(app, 'Foundation', common);
  const sitewise = new SiteWiseStack(app, 'SiteWise', {
    ...common,
    ...(options.plant ? { topology: options.plant } : {}),
  });
  const ingest = new IngestStack(app, 'Ingest', {
    ...common,
    machineAssetIds: sitewise.machineAssetIds,
    ruleErrorsLogGroup: foundation.ruleErrorsLogGroup,
    rawArchive: options.rawArchive ?? false,
  });
  const apiStack = new ApiStack(app, 'Api', { ...common, buildVersion: 'test' });
  const edge = new EdgeStack(app, 'Edge', {
    ...common,
    repository: foundation.simulatorRepository,
    imageTag: options.imageTag ?? 'abc1234',
  });
  const edgeHost = new EdgeHostStack(app, 'EdgeHost', common);
  const observability = new ObservabilityStack(app, 'Observability', {
    ...common,
    alertsTopic: foundation.alertsTopic,
    ...(options.alertEmail === null
      ? {}
      : { alertEmail: options.alertEmail ?? 'alerts@example.com' }),
    budgetUsd: 10,
    freshnessEnabled: options.freshnessEnabled ?? false,
    apiName: 'etp-query-api',
    apiStage: 'live',
    apiFunctions: Object.values(apiStack.functions),
  });
  const template = (stack: Stack) => Template.fromStack(stack);
  return {
    app,
    foundation: template(foundation),
    sitewise: template(sitewise),
    ingest: template(ingest),
    api: template(apiStack),
    observability: template(observability),
    edge: template(edge),
    edgeHost: template(edgeHost),
    componentVersion: edge.componentVersion,
  };
}

function resources(template: Template, type: string): Resource[] {
  return Object.values(template.findResources(type)) as Resource[];
}

const { app, foundation, sitewise, ingest, api, edge, edgeHost, observability, componentVersion } =
  synth();

describe('EtpSiteWise (FR-SW-1, FR-SW-2)', () => {
  it('creates the four asset models', () => {
    const names = resources(sitewise, 'AWS::IoTSiteWise::AssetModel').map(
      (r) => r.Properties.AssetModelName,
    );
    expect(names.sort()).toEqual(['etp-compressor', 'etp-line', 'etp-pump', 'etp-site']);
  });

  it('creates one asset per topology node, named and keyed by topology id', () => {
    const assets = resources(sitewise, 'AWS::IoTSiteWise::Asset');
    expect(assets).toHaveLength(1 + topology.lines.length + listMachines().length);
    const externalIds = assets.map((a) => a.Properties.AssetExternalId);
    expect(externalIds).toEqual(
      expect.arrayContaining(['kochi-01', 'kochi-01.line-a', 'kochi-01.line-b.comp-02']),
    );
    expect(assets.map((a) => a.Properties.AssetName)).toContain('kochi-01/line-a/pump-01');
  });

  it.each(listMachines().map((m) => [m.machineId, m] as const))(
    'sets the expected alias on every measurement of %s, with notifications off',
    (_id, machine) => {
      const asset = resources(sitewise, 'AWS::IoTSiteWise::Asset').find(
        (a) => a.Properties.AssetExternalId === `kochi-01.${machine.lineId}.${machine.machineId}`,
      );
      const expected = measurementNamesFor(machine.type).map((m) => ({
        LogicalId: m,
        Alias: aliasFor(machine.siteId, machine.lineId, machine.machineId, m),
        NotificationState: 'DISABLED',
      }));
      expect(asset?.Properties.AssetProperties).toEqual(expected);
    },
  );

  it('links lines to their machines and the site to its lines', () => {
    const byId = (id: string) =>
      resources(sitewise, 'AWS::IoTSiteWise::Asset').find(
        (a) => a.Properties.AssetExternalId === id,
      );
    const lineA = byId('kochi-01.line-a')?.Properties.AssetHierarchies as { LogicalId: string }[];
    expect(lineA.map((h) => h.LogicalId).sort()).toEqual(['compressors', 'pumps', 'pumps']);
    const site = byId('kochi-01')?.Properties.AssetHierarchies as unknown[];
    expect(site).toHaveLength(2);
  });

  it('exposes the root asset id as an output', () => {
    sitewise.hasOutput('RootAssetId', {});
  });

  it('adds an asset, aliases, and hierarchy link when a machine is added to the topology (FR-SW-3)', () => {
    const [lineA, lineB] = topology.lines;
    const plant: Topology = {
      site: topology.site,
      lines: [{ ...lineA, machines: [...lineA.machines, { id: 'pump-09', type: 'pump' }] }, lineB],
    };
    const extended = synth({ plant }).sitewise;
    const assets = resources(extended, 'AWS::IoTSiteWise::Asset');
    expect(assets).toHaveLength(9);
    const added = assets.find((a) => a.Properties.AssetExternalId === 'kochi-01.line-a.pump-09');
    expect(JSON.stringify(added?.Properties.AssetProperties)).toContain(
      '/kochi-01/line-a/pump-09/temperature_c',
    );
  });
});

describe('EtpIngest (FR-ING-1 to FR-ING-6)', () => {
  it.each(['pump', 'compressor'] as const)('routes %s telemetry with the v1 SQL', (type) => {
    ingest.hasResourceProperties('AWS::IoT::TopicRule', {
      RuleName: ruleNameFor(type),
      TopicRulePayload: Match.objectLike({
        Sql: `SELECT * FROM 'telemetry/v1/+/+/${type}/+'`,
        AwsIotSqlVersion: '2016-03-23',
        RuleDisabled: false,
      }),
    });
  });

  it('writes one alias-addressed entry per measurement with device timestamps', () => {
    const rule = resources(ingest, 'AWS::IoT::TopicRule').find(
      (r) => r.Properties.RuleName === ruleNameFor('compressor'),
    );
    const payload = rule?.Properties.TopicRulePayload as {
      Actions: { IotSiteWise: { PutAssetPropertyValueEntries: Record<string, unknown>[] } }[];
    };
    const entries = payload.Actions[0]?.IotSiteWise.PutAssetPropertyValueEntries ?? [];
    expect(entries.map((e) => e.EntryId)).toEqual(measurementNamesFor('compressor'));
    expect(entries[0]).toEqual({
      EntryId: 'temperature_c',
      PropertyAlias: '/${topic(3)}/${topic(4)}/${topic(6)}/temperature_c',
      PropertyValues: [
        {
          Quality: 'GOOD',
          Timestamp: { TimeInSeconds: '${floor(ts / 1E3)}', OffsetInNanos: '${(ts % 1E3) * 1E6}' },
          Value: { DoubleValue: '${metrics.temperature_c}' },
        },
      ],
    });
    expect(JSON.stringify(entries.at(-1))).toContain('"StringValue":"${status}"');
  });

  it('sends rule failures to the rule-errors log group', () => {
    ingest.hasResourceProperties('AWS::IoT::TopicRule', {
      TopicRulePayload: Match.objectLike({
        ErrorAction: { CloudwatchLogs: Match.objectLike({ LogGroupName: Match.anyValue() }) },
      }),
    });
    foundation.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: RULE_ERRORS_LOG_GROUP,
      RetentionInDays: 14,
    });
  });

  it("scopes the rule role to this site's data streams and machine assets (FR-ING-5)", () => {
    const policies = resources(ingest, 'AWS::IAM::Policy');
    const sitewisePolicy = policies.find((p) =>
      JSON.stringify(p.Properties).includes('BatchPutAssetPropertyValue'),
    );
    const doc = sitewisePolicy?.Properties.PolicyDocument as {
      Statement: { Action: string; Resource: unknown; Condition?: unknown }[];
    };
    expect(doc.Statement.map((s) => s.Action)).toEqual([
      'iotsitewise:BatchPutAssetPropertyValue',
      'iotsitewise:BatchPutAssetPropertyValue',
    ]);
    const [streams, assets] = doc.Statement;
    // Data streams: only aliases under this site.
    expect(JSON.stringify(streams?.Resource)).toContain(':time-series/*');
    expect(streams?.Condition).toEqual({
      StringLike: { 'iotsitewise:propertyAlias': '/kochi-01/*' },
    });
    // Assets: one explicit ARN per machine, no wildcard.
    expect(assets?.Resource).toHaveLength(listMachines().length);
    expect(JSON.stringify(assets?.Resource)).not.toContain('asset/*');
  });

  it('guards the IoT service principal against confused-deputy use', () => {
    ingest.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({
            Principal: { Service: 'iot.amazonaws.com' },
            Condition: { StringEquals: { 'aws:SourceAccount': Match.anyValue() } },
          }),
        ],
      }),
    });
  });

  it('archives raw payloads to a private, expiring bucket only when enabled (FR-ING-7)', () => {
    ingest.resourceCountIs('AWS::S3::Bucket', 0);
    const archived = synth({ rawArchive: true }).ingest;
    archived.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 7 })] },
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }),
    });
    expect(JSON.stringify(archived.toJSON())).toContain('raw/${topic(3)}/${topic(4)}/${topic(6)}/');
  });
});

describe('EtpFoundation', () => {
  it('scans simulator images on push and keeps the last five', () => {
    foundation.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'etp/simulator',
      ImageScanningConfiguration: { ScanOnPush: true },
      EmptyOnDelete: true,
      LifecyclePolicy: { LifecyclePolicyText: Match.stringLikeRegexp('"countNumber":5') },
    });
  });
});

describe('EtpApi (SRS 6.5)', () => {
  it('runs both services on nodejs24.x, ARM64, with X-Ray tracing', () => {
    const fns = resources(api, 'AWS::Lambda::Function');
    expect(fns).toHaveLength(2);
    for (const f of fns) {
      expect(f.Properties).toMatchObject({
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        TracingConfig: { Mode: 'Active' },
        MemorySize: 256,
        Timeout: 10,
      });
    }
  });

  it('bundles the AWS SDK into each function instead of relying on the runtime copy', () => {
    const outdir = app.synth().directory;
    const bundles = readdirSync(outdir)
      .filter((d) => d.startsWith('asset.') && statSync(join(outdir, d)).isDirectory())
      .map((d) => readFileSync(join(outdir, d, 'index.js'), 'utf8'));
    expect(bundles.length).toBeGreaterThanOrEqual(2);
    for (const code of bundles) {
      // A real import is `=require("...")`; the SDK also mentions require() inside error text.
      expect(code).not.toMatch(/[=,(]require\("@(aws-sdk|smithy)\//);
    }
  });

  it('keeps Lambda logs for 14 days', () => {
    for (const g of resources(api, 'AWS::Logs::LogGroup')) {
      expect(g.Properties.RetentionInDays).toBe(14);
    }
  });

  it('requires an API key on every route except health and CORS preflight (FR-API-9)', () => {
    const methods = resources(api, 'AWS::ApiGateway::Method');
    const gets = methods.filter((m) => m.Properties.HttpMethod === 'GET');
    expect(gets).toHaveLength(7);
    const open = gets.filter((m) => m.Properties.ApiKeyRequired !== true);
    expect(open.map((m) => m.Properties.OperationName)).toEqual(['FR-API-7']);
    for (const m of methods.filter((m) => m.Properties.HttpMethod === 'OPTIONS')) {
      expect(m.Properties.ApiKeyRequired).not.toBe(true);
    }
  });

  it('throttles and caps usage per key', () => {
    api.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
      Throttle: { RateLimit: USAGE_PLAN.rateLimit, BurstLimit: USAGE_PLAN.burstLimit },
      Quota: { Limit: USAGE_PLAN.dailyQuota, Period: 'DAY' },
    });
  });

  it('grants each function read-only SiteWise access, scoped to assets and models', () => {
    const json = JSON.stringify(resources(api, 'AWS::IAM::Policy'));
    expect(json).toContain('iotsitewise:GetAssetPropertyAggregates');
    expect(json).not.toMatch(/iotsitewise:(BatchPut|Create|Update|Delete|Associate)/);
    expect(json).toContain(':asset/*');
    expect(json).toContain(':asset-model/*');
  });

  it('never outputs the API key value', () => {
    const outputs = JSON.stringify(api.toJSON().Outputs);
    expect(outputs).toContain('ApiKeyId');
    expect(outputs).not.toMatch(/"Fn::GetAtt":\["DevApiKey/);
  });
});

describe('EtpEdge (SRS 6.2)', () => {
  const recipe = simulatorRecipe(
    '1.0.1',
    'acct.dkr.ecr.ap-south-1.amazonaws.com/etp/simulator:abc',
    5000,
  );
  const run = JSON.stringify(recipe);

  it('mounts the IPC socket and passes SVCUID into the container (FR-EDGE-3)', () => {
    expect(run).toContain(
      '-v $AWS_GG_NUCLEUS_DOMAIN_SOCKET_FILEPATH_FOR_COMPONENT:$AWS_GG_NUCLEUS_DOMAIN_SOCKET_FILEPATH_FOR_COMPONENT',
    );
    expect(run).toContain('-e SVCUID -e AWS_GG_NUCLEUS_DOMAIN_SOCKET_FILEPATH_FOR_COMPONENT');
    expect(run).toContain('-e TRANSPORT=ipc');
    expect(run).toContain(`docker stop --time 10 ${EDGE.container}`);
  });

  it('lets the component publish to telemetry/v1/# only', () => {
    const config = recipe.ComponentConfiguration as {
      DefaultConfiguration: {
        accessControl: Record<
          string,
          Record<string, { operations: string[]; resources: string[] }>
        >;
      };
    };
    const policies = Object.values(
      config.DefaultConfiguration.accessControl['aws.greengrass.ipc.mqttproxy'] ?? {},
    );
    expect(policies).toEqual([
      expect.objectContaining({
        operations: ['aws.greengrass#PublishToIoTCore'],
        resources: ['telemetry/v1/#'],
      }),
    ]);
  });

  it('pulls the image from the private ECR repo by immutable tag, via DockerApplicationManager and TES', () => {
    expect(JSON.stringify(recipe.Manifests)).toContain(
      '"URI":"docker:acct.dkr.ecr.ap-south-1.amazonaws.com/etp/simulator:abc"',
    );
    expect(Object.keys(recipe.ComponentDependencies as object)).toEqual([
      'aws.greengrass.DockerApplicationManager',
      'aws.greengrass.TokenExchangeService',
    ]);
  });

  it('derives a new component version when the image tag changes, and keeps it otherwise', () => {
    expect(componentVersion).toMatch(/^1\.0\.\d+$/);
    // Greengrass rejects any version part above 999999 (found on first deploy).
    for (const part of componentVersion.split('.'))
      expect(Number(part)).toBeLessThanOrEqual(999_999);
    expect(synth({ imageTag: 'abc1234' }).componentVersion).toBe(componentVersion);
    expect(synth({ imageTag: 'def5678' }).componentVersion).not.toBe(componentVersion);
  });

  it('deploys pinned versions with the MQTT spooler on disk (FR-EDGE-2, ADR 0005)', () => {
    const deployment = resources(edge, 'AWS::GreengrassV2::Deployment')[0];
    const components = deployment?.Properties.Components as Record<
      string,
      { ComponentVersion: string; ConfigurationUpdate?: { Merge: string } }
    >;
    expect(components['aws.greengrass.Nucleus']?.ComponentVersion).toBe(
      GREENGRASS_VERSIONS.nucleus,
    );
    expect(components['aws.greengrass.DiskSpooler']?.ComponentVersion).toBe(
      GREENGRASS_VERSIONS.diskSpooler,
    );
    expect(
      JSON.parse(components['aws.greengrass.Nucleus']?.ConfigurationUpdate?.Merge ?? '{}'),
    ).toEqual({
      jvmOptions: NUCLEUS_JVM_OPTIONS,
      mqtt: {
        spooler: {
          storageType: 'Disk',
          pluginName: 'aws.greengrass.DiskSpooler',
          maxSizeInBytes: SPOOLER_MAX_BYTES,
          keepQos0WhenOffline: false,
        },
      },
    });
    expect(Object.keys(components)).toContain(EDGE.component);
  });

  it('lets the token exchange role pull this repository only', () => {
    const json = JSON.stringify(resources(edge, 'AWS::IAM::Policy'));
    expect(json).toContain('ecr:BatchGetImage');
    expect(json).not.toMatch(
      /ecr:(Put|Delete|Create|Batch(Delete|Check)|Initiate|Upload|Complete)/,
    );
  });

  it('gives the core device a policy that names the thing and limits publishing', () => {
    const doc = JSON.stringify(resources(edge, 'AWS::IoT::Policy')[0]?.Properties.PolicyDocument);
    expect(doc).toContain(`client/${EDGE.coreThingName}*`);
    expect(doc).toContain('topic/telemetry/v1/*');
    expect(doc).not.toContain('iot:*');
    expect(doc).not.toContain('greengrass:*');
    expect(doc).not.toContain('iot:Connection.Thing');
  });
});

describe('EtpEdgeHost (FR-EDGE-6)', () => {
  it('opens no inbound ports and requires IMDSv2', () => {
    for (const sg of resources(edgeHost, 'AWS::EC2::SecurityGroup')) {
      expect(sg.Properties.SecurityGroupIngress).toBeUndefined();
    }
    edgeHost.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    edgeHost.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } },
    });
  });

  it('runs a t2.micro (account vCPU quota) with an encrypted gp3 volume and no NAT gateway', () => {
    edgeHost.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't2.micro',
      BlockDeviceMappings: [
        Match.objectLike({ Ebs: Match.objectLike({ Encrypted: true, VolumeType: 'gp3' }) }),
      ],
    });
    edgeHost.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  it('verifies and installs the pinned nucleus with manual provisioning into the group', () => {
    const userData = JSON.stringify(
      resources(edgeHost, 'AWS::EC2::Instance')[0]?.Properties.UserData,
    );
    expect(userData).toContain(`greengrass-${GREENGRASS_VERSIONS.nucleus}.zip`);
    expect(userData).toContain('jarsigner -verify');
    expect(userData).toContain('create-keys-and-certificate --set-as-active');
    expect(userData).toContain(`--thing-group-name ${EDGE.thingGroup}`);
    expect(userData).toContain('--init-config /tmp/GreengrassInstaller/config.yaml');
    expect(userData).not.toContain('--provision true');
    expect(userData).toContain('sha256sum --check --strict');
    expect(userData).toContain('usermod -aG docker ggc_user');
    expect(userData).toContain('mkswap /swapfile');
  });

  it('gives the host IoT provisioning rights for the named thing only, and no IAM rights', () => {
    const statements = resources(edgeHost, 'AWS::IAM::Policy').flatMap(
      (p) =>
        (
          p.Properties.PolicyDocument as {
            Statement: { Sid?: string; Action: unknown; Resource: unknown }[];
          }
        ).Statement,
    );
    const json = JSON.stringify(statements);
    expect(json).not.toMatch(/"iam:/);
    expect(json).toContain(`thing/${EDGE.coreThingName}`);
    expect(json).toContain(`policy/${EDGE.corePolicy}`);
    // AttachThingPrincipal is authorized against the new certificate too (found on first deploy).
    const provision = statements.find((st) => st.Sid === 'ProvisionCoreThing');
    expect(JSON.stringify(provision?.Resource)).toContain(':cert/*');
  });
});

describe('EtpObservability (SRS 6.6)', () => {
  const alarms = () => resources(observability, 'AWS::CloudWatch::Alarm');

  it('alarms on stale data per machine: over 120 s for 3 of 3 minutes, quiet when the monitor is off', () => {
    const stale = alarms().filter((a) => String(a.Properties.AlarmName).startsWith('etp-stale-'));
    expect(stale.map((a) => a.Properties.AlarmName)).toEqual(
      listMachines().map((m) => `etp-stale-${m.machineId}`),
    );
    for (const a of stale) {
      expect(a.Properties).toMatchObject({
        MetricName: 'SecondsSinceLastValue',
        Namespace: 'EdgeTelemetryPlatform',
        Threshold: 120,
        EvaluationPeriods: 3,
        DatapointsToAlarm: 3,
        Period: 60,
        TreatMissingData: 'notBreaching',
      });
      expect(JSON.stringify(a.Properties.Dimensions)).toContain('freshness-monitor');
    }
  });

  it('raises "simulator offline" only when every machine is stale', () => {
    const composite = resources(observability, 'AWS::CloudWatch::CompositeAlarm')[0];
    const rule = JSON.stringify(composite?.Properties.AlarmRule);
    expect(rule.match(/ALARM\(/g)).toHaveLength(listMachines().length);
    expect(rule).toContain(' AND ');
    expect(rule).not.toContain(' OR ');
  });

  it('alarms on SiteWise rule failures, Lambda errors, and the API 5xx rate', () => {
    const names = alarms().map((a) => String(a.Properties.AlarmName));
    expect(names.filter((n) => n.startsWith('etp-rule-failures-'))).toHaveLength(2);
    expect(names.filter((n) => n.startsWith('etp-lambda-errors-'))).toHaveLength(3);
    expect(names).toContain('etp-api-5xx-rate');
    const ruleAlarm = alarms().find((a) => a.Properties.AlarmName === 'etp-rule-failures-pump');
    expect(ruleAlarm?.Properties.Dimensions).toEqual(
      expect.arrayContaining([{ Name: 'ActionType', Value: 'IotSiteWise' }]),
    );
  });

  it('sends every alarm to the alerts topic', () => {
    for (const a of [...alarms(), ...resources(observability, 'AWS::CloudWatch::CompositeAlarm')]) {
      expect((a.Properties.AlarmActions as unknown[]).length).toBe(1);
    }
  });

  it('runs the freshness monitor every minute, off by default and on when asked', () => {
    observability.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: FRESHNESS_SCHEDULE,
      ScheduleExpression: 'rate(1 minute)',
      State: 'DISABLED',
    });
    synth({ freshnessEnabled: true }).observability.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      {
        State: 'ENABLED',
      },
    );
  });

  it('budgets USD 10 a month with 50, 80, 100 percent actual and 100 percent forecast alerts', () => {
    const budget = resources(observability, 'AWS::Budgets::Budget')[0];
    expect(budget?.Properties.Budget).toMatchObject({
      BudgetLimit: { Amount: 10, Unit: 'USD' },
      TimeUnit: 'MONTHLY',
      BudgetType: 'COST',
    });
    const thresholds = (
      budget?.Properties.NotificationsWithSubscribers as {
        Notification: { Threshold: number; NotificationType: string };
      }[]
    ).map((n) => `${String(n.Notification.Threshold)} ${n.Notification.NotificationType}`);
    expect(thresholds).toEqual(['50 ACTUAL', '80 ACTUAL', '100 ACTUAL', '100 FORECASTED']);
  });

  it('subscribes the email passed as context, and creates no subscription or budget without one', () => {
    observability.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'alerts@example.com',
    });
    const none = synth({ alertEmail: null }).observability;
    none.resourceCountIs('AWS::SNS::Subscription', 0);
    none.resourceCountIs('AWS::Budgets::Budget', 0);
  });

  it('builds the etp-overview dashboard', () => {
    observability.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: DASHBOARD_NAME,
    });
  });

  it('never hard-codes a personal email address in the source', () => {
    const source = readdirSync(join(import.meta.dirname, '..', 'src', 'stacks'))
      .map((f) => readFileSync(join(import.meta.dirname, '..', 'src', 'stacks', f), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/@gmail\.com/);
  });
});

describe('security and hygiene across all stacks (NFR-4, NFR-8)', () => {
  const templates = { foundation, sitewise, ingest, api, edge, edgeHost, observability };

  it('has no IAM statement with a wildcard action', () => {
    for (const [name, t] of Object.entries(templates)) {
      const json = JSON.stringify(t.toJSON());
      expect(json, name).not.toMatch(/"Action":\s*"(\w+:)?\*"/);
      expect(json, name).not.toMatch(/"Action":\s*\[[^\]]*"(\w+:)?\*"/);
    }
  });

  it('retains nothing on delete', () => {
    for (const [name, t] of Object.entries(templates)) {
      expect(JSON.stringify(t.toJSON()), name).not.toContain('"DeletionPolicy":"Retain"');
    }
  });

  it('tags every stack with the project tags', () => {
    const assembly = app.synth();
    for (const id of [
      'Foundation',
      'SiteWise',
      'Ingest',
      'Api',
      'Edge',
      'EdgeHost',
      'Observability',
    ]) {
      expect(assembly.getStackByName(id).tags).toEqual(PROJECT_TAGS);
    }
  });
});
