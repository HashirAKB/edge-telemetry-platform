import { IoTSiteWiseClient } from '@aws-sdk/client-iotsitewise';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { METRICS_NAMESPACE, type ApiService } from '@etp/shared';
import type { AppLogger, AppMetrics } from './http/app.js';
import { CatalogService } from './services/catalog.js';
import { SdkSiteWiseReader } from './sitewise/sdk-reader.js';

/**
 * Lambda wiring shared by both handlers: Powertools (FR-OBS-1) and the SiteWise client.
 * Created once per execution environment, so the client and the tree cache survive across
 * warm invocations.
 */
export function createRuntime(service: ApiService) {
  const logger = new Logger({ serviceName: service });
  const metrics = new Metrics({ serviceName: service, namespace: METRICS_NAMESPACE });
  const tracer = new Tracer({ serviceName: service });
  const client = tracer.captureAWSv3Client(new IoTSiteWiseClient({}));
  const reader = new SdkSiteWiseReader(client);
  const catalog = new CatalogService(reader, {
    rootExternalId: process.env.ROOT_ASSET_EXTERNAL_ID ?? 'kochi-01',
  });

  const appMetrics: AppMetrics = {
    addDimension: (name, value) => {
      metrics.addDimension(name, value);
    },
    addMetric: (name, unit, value) => {
      metrics.addMetric(name, unit === 'Count' ? MetricUnit.Count : MetricUnit.Milliseconds, value);
    },
    publishStoredMetrics: () => {
      metrics.publishStoredMetrics();
    },
  };
  const appLogger: AppLogger = {
    addContext: (context) => {
      logger.addContext(context);
    },
    appendKeys: (keys) => {
      logger.appendKeys(keys);
    },
    resetKeys: () => {
      logger.resetKeys();
    },
    info: (message, extra = {}) => {
      logger.info(message, extra);
    },
    warn: (message, extra = {}) => {
      logger.warn(message, extra);
    },
    error: (message, extra = {}) => {
      logger.error(message, extra);
    },
  };
  return { logger: appLogger, metrics: appMetrics, reader, catalog };
}
