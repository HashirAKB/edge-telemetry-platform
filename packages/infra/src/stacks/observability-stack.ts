import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import {
  FRESHNESS_METRIC,
  FRESHNESS_SERVICE,
  listMachines,
  MACHINE_TYPES,
  METRICS_NAMESPACE,
  STALE_EVALUATION_MINUTES,
  STALE_THRESHOLD_SECONDS,
} from '@etp/shared';
import { tsLambda } from '../constructs/ts-lambda.js';
import { ruleNameFor } from './ingest-stack.js';

export const FRESHNESS_SCHEDULE = 'etp-freshness-monitor';
export const DASHBOARD_NAME = 'etp-overview';

export interface ObservabilityStackProps extends StackProps {
  readonly alertsTopic: sns.ITopic;
  /** Subscribed to alerts and budget notifications. Passed as CDK context, never committed. */
  readonly alertEmail?: string;
  /** Monthly cost budget in USD (FR-OBS-5). */
  readonly budgetUsd: number;
  /** Freshness schedule on at deploy time. Off by default; toggled with pnpm monitor:on/off. */
  readonly freshnessEnabled?: boolean;
  readonly apiName: string;
  readonly apiStage: string;
  readonly apiFunctions: readonly lambda.IFunction[];
}

/** Dashboard, alarms, freshness monitor, and cost budget (SRS 6.6). */
export class ObservabilityStack extends Stack {
  readonly staleAlarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const alarmAction = new cwActions.SnsAction(props.alertsTopic);
    const notify = <
      T extends cloudwatch.IAlarm & { addAlarmAction(...a: cloudwatch.IAlarmAction[]): void },
    >(
      alarm: T,
    ): T => {
      alarm.addAlarmAction(alarmAction);
      return alarm;
    };

    // Created here rather than with topic.addSubscription(), which would place it in the
    // topic's own stack (EtpFoundation). AWS emails a confirmation link before alerts flow.
    if (props.alertEmail) {
      new sns.Subscription(this, 'AlertEmail', {
        topic: props.alertsTopic,
        protocol: sns.SubscriptionProtocol.EMAIL,
        endpoint: props.alertEmail,
      });
    }

    // ---------- Freshness monitor (FR-OBS-2) ----------
    const monitor = tsLambda(this, FRESHNESS_SERVICE, {
      handler: 'freshness-monitor',
      service: FRESHNESS_SERVICE,
      description: 'etp freshness monitor: seconds since each machine last reported',
      timeout: Duration.seconds(30),
    });
    monitor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iotsitewise:DescribeAsset', 'iotsitewise:BatchGetAssetPropertyValue'],
        resources: [`arn:${this.partition}:iotsitewise:${this.region}:${this.account}:asset/*`],
      }),
    );
    new scheduler.Schedule(this, 'FreshnessSchedule', {
      scheduleName: FRESHNESS_SCHEDULE,
      description: 'Every minute: publish SecondsSinceLastValue per machine',
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(1)),
      target: new targets.LambdaInvoke(monitor, { retryAttempts: 0 }),
      // Off by default: the platform runs on demand, and an always-on monitor would page on
      // every intentional shutdown (docs/cost.md). pnpm monitor:on enables it for demos.
      enabled: props.freshnessEnabled ?? false,
    });

    // ---------- Alarms (FR-OBS-3) ----------
    const freshness = (machineId: string) =>
      new cloudwatch.Metric({
        namespace: METRICS_NAMESPACE,
        metricName: FRESHNESS_METRIC,
        dimensionsMap: { service: FRESHNESS_SERVICE, machineId },
        statistic: cloudwatch.Stats.MAXIMUM,
        period: Duration.minutes(1),
      });

    for (const machine of listMachines()) {
      this.staleAlarms.push(
        notify(
          new cloudwatch.Alarm(this, `Stale-${machine.machineId}`, {
            alarmName: `etp-stale-${machine.machineId}`,
            alarmDescription: `${machine.machineId}: no value for over ${String(STALE_THRESHOLD_SECONDS)} s`,
            metric: freshness(machine.machineId),
            threshold: STALE_THRESHOLD_SECONDS,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            evaluationPeriods: STALE_EVALUATION_MINUTES,
            datapointsToAlarm: STALE_EVALUATION_MINUTES,
            // No data means the monitor is off (on-demand platform), not that data is stale.
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          }),
        ),
      );
    }

    notify(
      new cloudwatch.CompositeAlarm(this, 'SimulatorOffline', {
        compositeAlarmName: 'etp-simulator-offline',
        alarmDescription: 'Every machine is stale: the edge or its publisher is down',
        alarmRule: cloudwatch.AlarmRule.allOf(...this.staleAlarms),
      }),
    );

    for (const type of MACHINE_TYPES) {
      const rule = ruleNameFor(type);
      notify(
        new cloudwatch.Alarm(this, `RuleFailures-${type}`, {
          alarmName: `etp-rule-failures-${type}`,
          alarmDescription: `IoT rule ${rule} failed to write to SiteWise`,
          metric: new cloudwatch.Metric({
            namespace: 'AWS/IoT',
            metricName: 'Failure',
            dimensionsMap: { RuleName: rule, ActionType: 'IotSiteWise' },
            statistic: cloudwatch.Stats.SUM,
            period: Duration.minutes(5),
          }),
          threshold: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
      );
    }

    const allFunctions = [...props.apiFunctions, monitor];
    allFunctions.forEach((fn, i) => {
      notify(
        new cloudwatch.Alarm(this, `LambdaErrors-${String(i)}`, {
          alarmName: `etp-lambda-errors-${fn.node.id}`,
          alarmDescription: `Lambda ${fn.node.id} reported errors`,
          metric: fn.metricErrors({ period: Duration.minutes(5), statistic: cloudwatch.Stats.SUM }),
          threshold: 0,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
      );
    });

    const apiMetric = (metricName: string, statistic: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName,
        dimensionsMap: { ApiName: props.apiName, Stage: props.apiStage },
        statistic,
        period: Duration.minutes(5),
      });
    const serverErrorRate = new cloudwatch.MathExpression({
      expression: 'IF(requests > 0, 100 * errors / requests, 0)',
      usingMetrics: {
        errors: apiMetric('5XXError', cloudwatch.Stats.SUM),
        requests: apiMetric('Count', cloudwatch.Stats.SUM),
      },
      label: 'API 5xx rate (%)',
      period: Duration.minutes(5),
    });
    notify(
      new cloudwatch.Alarm(this, 'Api5xxRate', {
        alarmName: 'etp-api-5xx-rate',
        alarmDescription: 'More than 1% of API requests returned 5xx',
        metric: serverErrorRate,
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    // ---------- Dashboard (FR-OBS-4) ----------
    const ruleMetric = (metricName: string, type: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/IoT',
        metricName,
        dimensionsMap:
          metricName === 'TopicMatch'
            ? { RuleName: ruleNameFor(type as (typeof MACHINE_TYPES)[number]) }
            : {
                RuleName: ruleNameFor(type as (typeof MACHINE_TYPES)[number]),
                ActionType: 'IotSiteWise',
              },
        statistic: cloudwatch.Stats.SUM,
        period: Duration.minutes(1),
        label: `${metricName} ${type}`,
      });
    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: DASHBOARD_NAME,
      defaultInterval: Duration.hours(1),
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'Ingest: messages matched per minute',
            left: MACHINE_TYPES.map((t) => ruleMetric('TopicMatch', t)),
            width: 12,
          }),
          new cloudwatch.GraphWidget({
            title: 'Ingest: SiteWise write failures',
            left: MACHINE_TYPES.map((t) => ruleMetric('Failure', t)),
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Freshness: seconds since last value',
            left: listMachines().map((m) => freshness(m.machineId).with({ label: m.machineId })),
            leftAnnotations: [{ value: STALE_THRESHOLD_SECONDS, label: 'stale', color: '#d62728' }],
            width: 12,
          }),
          new cloudwatch.GraphWidget({
            title: 'API latency (ms)',
            left: (['p50', 'p95', 'p99'] as const).map((p) =>
              apiMetric('Latency', p).with({ label: p, period: Duration.minutes(1) }),
            ),
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Lambda errors',
            left: allFunctions.map((fn) =>
              fn.metricErrors({ period: Duration.minutes(5), label: fn.node.id }),
            ),
            width: 12,
          }),
          new cloudwatch.GraphWidget({
            title: 'API requests and 5xx rate',
            left: [apiMetric('Count', cloudwatch.Stats.SUM).with({ label: 'requests' })],
            right: [serverErrorRate],
            width: 12,
          }),
        ],
      ],
    });

    // ---------- Cost budget (FR-OBS-5) ----------
    if (props.alertEmail) {
      const subscriber = { subscriptionType: 'EMAIL', address: props.alertEmail };
      const at = (threshold: number, notificationType: 'ACTUAL' | 'FORECASTED') => ({
        notification: {
          comparisonOperator: 'GREATER_THAN',
          notificationType,
          threshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [subscriber],
      });
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: 'etp-monthly',
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: props.budgetUsd, unit: 'USD' },
        },
        notificationsWithSubscribers: [
          at(50, 'ACTUAL'),
          at(80, 'ACTUAL'),
          at(100, 'ACTUAL'),
          at(100, 'FORECASTED'),
        ],
      });
    }
  }
}
