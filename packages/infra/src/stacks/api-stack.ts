import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import { tsLambda } from '../constructs/ts-lambda.js';
import {
  API_KEY_HEADER,
  API_ROUTES,
  assetExternalIdFor,
  DEFAULT_PUBLISH_INTERVAL_MS,
  topology,
  type ApiService,
} from '@etp/shared';

export interface ApiStackProps extends StackProps {
  /** Shown by /v1/health; defaults to "dev". */
  readonly buildVersion?: string;
}

/** FR-API-9: per-key throttling and daily quota. */
export const USAGE_PLAN = { rateLimit: 10, burstLimit: 20, dailyQuota: 10_000 } as const;

/** SiteWise read actions each service needs, and nothing else (NFR-4, ADR 0007). */
const READ_ACTIONS: Record<ApiService, { assets: string[]; models: string[] }> = {
  'asset-catalog': {
    assets: ['iotsitewise:DescribeAsset', 'iotsitewise:ListAssociatedAssets'],
    models: ['iotsitewise:DescribeAssetModel'],
  },
  'telemetry-query': {
    assets: [
      'iotsitewise:DescribeAsset',
      'iotsitewise:ListAssociatedAssets',
      'iotsitewise:BatchGetAssetPropertyValue',
      'iotsitewise:GetAssetPropertyValueHistory',
      'iotsitewise:GetAssetPropertyAggregates',
    ],
    models: ['iotsitewise:DescribeAssetModel'],
  },
};

/** Query API (SRS 6.5): REST API Gateway in front of two TypeScript Lambda services. */
export class ApiStack extends Stack {
  readonly api: apigw.RestApi;
  readonly functions: Readonly<Record<ApiService, nodejs.NodejsFunction>>;

  constructor(scope: Construct, id: string, props: ApiStackProps = {}) {
    super(scope, id, props);

    const fn = (service: ApiService): nodejs.NodejsFunction => {
      const f = tsLambda(this, service, {
        handler: service,
        service,
        description: `etp ${service} (query API)`,
        environment: {
          ROOT_ASSET_EXTERNAL_ID: assetExternalIdFor(topology.site.id),
          PUBLISH_INTERVAL_MS: String(DEFAULT_PUBLISH_INTERVAL_MS),
          BUILD_VERSION: props.buildVersion ?? 'dev',
        },
      });
      const arn = (resource: string) =>
        `arn:${this.partition}:iotsitewise:${this.region}:${this.account}:${resource}`;
      const actions = READ_ACTIONS[service];
      f.addToRolePolicy(
        new iam.PolicyStatement({ actions: actions.assets, resources: [arn('asset/*')] }),
      );
      f.addToRolePolicy(
        new iam.PolicyStatement({ actions: actions.models, resources: [arn('asset-model/*')] }),
      );
      return f;
    };
    this.functions = {
      'asset-catalog': fn('asset-catalog'),
      'telemetry-query': fn('telemetry-query'),
    };

    this.api = new apigw.RestApi(this, 'QueryApi', {
      restApiName: 'etp-query-api',
      description: 'Typed telemetry query API over the plant asset hierarchy',
      endpointTypes: [apigw.EndpointType.REGIONAL],
      cloudWatchRole: false,
      deployOptions: {
        stageName: 'live',
        tracingEnabled: true,
        throttlingRateLimit: USAGE_PLAN.rateLimit,
        throttlingBurstLimit: USAGE_PLAN.burstLimit,
      },
      // FR-API-10: read-only API, so GET from any origin is acceptable for this build.
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'OPTIONS'],
        allowHeaders: ['content-type', API_KEY_HEADER],
      },
    });

    // Gateway-generated errors (missing key, throttled) carry CORS headers too.
    for (const type of [apigw.ResponseType.DEFAULT_4XX, apigw.ResponseType.DEFAULT_5XX]) {
      this.api.addGatewayResponse(`Gateway${type.responseType}`, {
        type,
        responseHeaders: { 'Access-Control-Allow-Origin': "'*'" },
      });
    }

    const integrations = {
      'asset-catalog': new apigw.LambdaIntegration(this.functions['asset-catalog']),
      'telemetry-query': new apigw.LambdaIntegration(this.functions['telemetry-query']),
    };
    for (const route of API_ROUTES) {
      const resource = this.api.root.resourceForPath(route.path.slice(1));
      resource.addMethod(route.method.toUpperCase(), integrations[route.service], {
        apiKeyRequired: route.requiresApiKey,
        operationName: route.id,
      });
    }

    // FR-API-9: one key for this build; its value is never written to outputs or logs.
    const key = new apigw.ApiKey(this, 'DevApiKey', {
      apiKeyName: 'etp-dev',
      description: 'Development key for the etp query API',
    });
    const plan = new apigw.UsagePlan(this, 'UsagePlan', {
      name: 'etp-default',
      throttle: { rateLimit: USAGE_PLAN.rateLimit, burstLimit: USAGE_PLAN.burstLimit },
      quota: { limit: USAGE_PLAN.dailyQuota, period: apigw.Period.DAY },
    });
    plan.addApiStage({ stage: this.api.deploymentStage });
    plan.addApiKey(key);

    new CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'Base URL of the query API',
    });
    new CfnOutput(this, 'ApiKeyId', {
      value: key.keyId,
      description: 'API key ID (not the secret); read the value with apigateway get-api-key',
    });
  }
}
