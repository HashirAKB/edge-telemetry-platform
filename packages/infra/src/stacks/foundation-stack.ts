import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

export const RULE_ERRORS_LOG_GROUP = '/etp/iot/rule-errors';

/**
 * Shared resources that other stacks reference (SRS section 10). Everything is removed by
 * `cdk destroy` (NFR-8), including images and log data.
 */
export class FoundationStack extends Stack {
  readonly simulatorRepository: ecr.Repository;
  readonly alertsTopic: sns.Topic;
  readonly ruleErrorsLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.simulatorRepository = new ecr.Repository(this, 'SimulatorRepository', {
      repositoryName: 'etp/simulator',
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [{ description: 'Keep the last 5 images', maxImageCount: 5 }],
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // Subscribers (email from CDK context) are added in the observability phase.
    this.alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      topicName: 'etp-alerts',
      enforceSSL: true,
    });

    this.ruleErrorsLogGroup = new logs.LogGroup(this, 'RuleErrorsLogGroup', {
      logGroupName: RULE_ERRORS_LOG_GROUP,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
