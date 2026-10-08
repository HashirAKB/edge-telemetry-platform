import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import type * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import {
  MACHINE_TYPES,
  NUMERIC_MEASUREMENTS,
  ruleAliasTemplate,
  ruleSqlForType,
  STATUS_MEASUREMENT,
  TOPIC_SEGMENT,
  type MachineType,
} from '@etp/shared';

export interface IngestStackProps extends StackProps {
  /** Root of the SiteWise hierarchy; the rule role may only write beneath it (FR-ING-5). */
  readonly rootAssetId: string;
  readonly ruleErrorsLogGroup: logs.ILogGroup;
  /** FR-ING-7: also archive raw payloads to S3. Off by default. */
  readonly rawArchive?: boolean;
}

export const IOT_SQL_VERSION = '2016-03-23';

export function ruleNameFor(type: MachineType): string {
  return `etp_telemetry_v1_${type}`;
}

/** Device timestamp (epoch ms in `ts`) as SiteWise seconds plus nanos (FR-ING-3, ADR 0004). */
const TIMESTAMP = {
  timeInSeconds: '${floor(ts / 1E3)}',
  offsetInNanos: '${(ts % 1E3) * 1E6}',
};

/** One SiteWise entry per measurement plus status, addressed by alias (FR-ING-2, FR-ING-4). */
export function putEntriesFor(type: MachineType) {
  const numeric = NUMERIC_MEASUREMENTS[type].map((m) => ({
    entryId: m.name,
    propertyAlias: ruleAliasTemplate(m.name),
    propertyValues: [
      { timestamp: TIMESTAMP, quality: 'GOOD', value: { doubleValue: `\${metrics.${m.name}}` } },
    ],
  }));
  const status = {
    entryId: STATUS_MEASUREMENT.name,
    propertyAlias: ruleAliasTemplate(STATUS_MEASUREMENT.name),
    propertyValues: [
      { timestamp: TIMESTAMP, quality: 'GOOD', value: { stringValue: '${status}' } },
    ],
  };
  return [...numeric, status];
}

/** IoT topic rules that route telemetry into SiteWise (SRS 6.3, ADR 0002). */
export class IngestStack extends Stack {
  readonly rules: Readonly<Record<MachineType, iot.CfnTopicRule>>;

  constructor(scope: Construct, id: string, props: IngestStackProps) {
    super(scope, id, props);

    const iotPrincipal = new iam.ServicePrincipal('iot.amazonaws.com', {
      // Confused-deputy guard: only rules in this account may assume these roles.
      conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
    });

    const ruleRole = new iam.Role(this, 'SiteWiseRuleRole', {
      assumedBy: iotPrincipal,
      description: 'IoT rules write telemetry into the etp SiteWise hierarchy only',
    });
    // Verified live (ADR 0012): for aliases that belong to asset properties, SiteWise authorizes
    // each entry against the asset. The AWS IoT docs example (Resource "*" with this condition)
    // was denied; scoping Resource to asset ARNs with the same condition works and limits the
    // role to the site's own asset tree.
    ruleRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iotsitewise:BatchPutAssetPropertyValue'],
        resources: [`arn:${this.partition}:iotsitewise:${this.region}:${this.account}:asset/*`],
        conditions: {
          StringLike: {
            'iotsitewise:assetHierarchyPath': [`/${props.rootAssetId}`, `/${props.rootAssetId}/*`],
          },
        },
      }),
    );

    const errorRole = new iam.Role(this, 'RuleErrorRole', {
      assumedBy: iotPrincipal,
      description: 'IoT rule error action writes failures to the rule-errors log group',
    });
    errorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'],
        resources: [props.ruleErrorsLogGroup.logGroupArn],
      }),
    );

    const archive = props.rawArchive ? this.createRawArchive(iotPrincipal) : undefined;

    const rules: Partial<Record<MachineType, iot.CfnTopicRule>> = {};
    for (const type of MACHINE_TYPES) {
      rules[type] = new iot.CfnTopicRule(this, `Rule-${type}`, {
        ruleName: ruleNameFor(type),
        topicRulePayload: {
          description: `telemetry v1 ${type} messages into SiteWise`,
          sql: ruleSqlForType(type),
          awsIotSqlVersion: IOT_SQL_VERSION,
          ruleDisabled: false,
          actions: [
            {
              iotSiteWise: {
                roleArn: ruleRole.roleArn,
                putAssetPropertyValueEntries: putEntriesFor(type),
              },
            },
            ...(archive ? [archive.action] : []),
          ],
          errorAction: {
            cloudwatchLogs: {
              logGroupName: props.ruleErrorsLogGroup.logGroupName,
              roleArn: errorRole.roleArn,
            },
          },
        },
      });
    }
    this.rules = rules as Record<MachineType, iot.CfnTopicRule>;
  }

  /** FR-ING-7: raw payloads under raw/{site}/{line}/{machine}/{yyyy}/{mm}/{dd}/, kept 7 days. */
  private createRawArchive(principal: iam.IPrincipal) {
    const bucket = new s3.Bucket(this, 'RawArchive', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(7) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const role = new iam.Role(this, 'RawArchiveRole', { assumedBy: principal });
    bucket.grantPut(role, 'raw/*');

    const t = (n: number) => `\${topic(${n})}`;
    const key =
      `raw/${t(TOPIC_SEGMENT.site)}/${t(TOPIC_SEGMENT.line)}/${t(TOPIC_SEGMENT.machine)}/` +
      '${parse_time("yyyy/MM/dd", ts, "UTC")}/${ts}-${seq}.json';
    return {
      bucket,
      action: { s3: { bucketName: bucket.bucketName, key, roleArn: role.roleArn } },
    };
  }
}
