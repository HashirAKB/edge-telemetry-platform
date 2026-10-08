import { App, type Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { aliasFor, listMachines, measurementNamesFor, topology, type Topology } from '@etp/shared';
import { FoundationStack, RULE_ERRORS_LOG_GROUP } from '../src/stacks/foundation-stack.js';
import { IngestStack, ruleNameFor } from '../src/stacks/ingest-stack.js';
import { SiteWiseStack } from '../src/stacks/sitewise-stack.js';
import { PROJECT_TAGS } from '../src/tags.js';

interface Resource {
  Type: string;
  Properties: Record<string, unknown>;
}

function synth(options: { plant?: Topology; rawArchive?: boolean } = {}) {
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
  const template = (stack: Stack) => Template.fromStack(stack);
  return {
    app,
    foundation: template(foundation),
    sitewise: template(sitewise),
    ingest: template(ingest),
  };
}

function resources(template: Template, type: string): Resource[] {
  return Object.values(template.findResources(type)) as Resource[];
}

const { app, foundation, sitewise, ingest } = synth();

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

describe('security and hygiene across all stacks (NFR-4, NFR-8)', () => {
  const templates = { foundation, sitewise, ingest };

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
    for (const id of ['Foundation', 'SiteWise', 'Ingest']) {
      expect(assembly.getStackByName(id).tags).toEqual(PROJECT_TAGS);
    }
  });
});
