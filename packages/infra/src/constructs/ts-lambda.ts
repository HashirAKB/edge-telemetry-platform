import { join } from 'node:path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { METRICS_NAMESPACE } from '@etp/shared';

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

export interface TsLambdaProps {
  /** File name (without extension) in packages/api/src/handlers. */
  readonly handler: string;
  /** Powertools service name; also the log and metric `service` dimension. */
  readonly service: string;
  readonly description: string;
  readonly environment?: Record<string, string>;
  readonly timeout?: Duration;
}

/**
 * The project's standard TypeScript Lambda: nodejs24.x on ARM64, X-Ray tracing, 14 day logs, and
 * an esbuild bundle that includes the AWS SDK (ADR 0007) and resolves workspace sources (ADR 0010).
 */
export function tsLambda(
  scope: Construct,
  id: string,
  props: TsLambdaProps,
): nodejs.NodejsFunction {
  const logGroup = new logs.LogGroup(scope, `${id}-logs`, {
    retention: logs.RetentionDays.TWO_WEEKS,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  return new nodejs.NodejsFunction(scope, id, {
    entry: join(REPO_ROOT, 'packages/api/src/handlers', `${props.handler}.ts`),
    handler: 'handler',
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: 256,
    timeout: props.timeout ?? Duration.seconds(10),
    tracing: lambda.Tracing.ACTIVE,
    logGroup,
    description: props.description,
    projectRoot: REPO_ROOT,
    depsLockFilePath: join(REPO_ROOT, 'pnpm-lock.yaml'),
    environment: {
      POWERTOOLS_SERVICE_NAME: props.service,
      POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
      NODE_OPTIONS: '--enable-source-maps',
      ...props.environment,
    },
    bundling: {
      minify: true,
      sourceMap: true,
      target: 'node24',
      // Resolve workspace packages to their TypeScript sources (see ADR 0010).
      esbuildArgs: { '--conditions': '@etp/source' },
      // Bundle the AWS SDK instead of using the runtime's copy: the deployed code runs the
      // exact locked version we test, and the runtime does not expose every @smithy/*
      // package the SDK imports (found on first deploy, ADR 0007).
      externalModules: [],
    },
  });
}
