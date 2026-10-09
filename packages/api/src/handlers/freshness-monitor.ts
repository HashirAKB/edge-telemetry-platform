import { IoTSiteWiseClient } from '@aws-sdk/client-iotsitewise';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { FRESHNESS_METRIC, FRESHNESS_SERVICE, METRICS_NAMESPACE } from '@etp/shared';
import { FreshnessMonitor } from '../services/freshness.js';
import { SdkSiteWiseReader } from '../sitewise/sdk-reader.js';

const logger = new Logger({ serviceName: FRESHNESS_SERVICE });
const metrics = new Metrics({ serviceName: FRESHNESS_SERVICE, namespace: METRICS_NAMESPACE });
const tracer = new Tracer({ serviceName: FRESHNESS_SERVICE });
const monitor = new FreshnessMonitor(
  new SdkSiteWiseReader(tracer.captureAWSv3Client(new IoTSiteWiseClient({}))),
);

/** FR-OBS-2: runs every minute (EventBridge Scheduler) and publishes one metric per machine. */
export const handler = async (): Promise<void> => {
  const results = await monitor.measure();
  for (const { machineId, secondsSinceLastValue } of results) {
    // One EMF document per machine: each carries its own machineId dimension value.
    const single = metrics.singleMetric();
    single.addDimension('machineId', machineId);
    single.addMetric(FRESHNESS_METRIC, MetricUnit.Seconds, secondsSinceLastValue);
  }
  logger.info('freshness measured', { machines: results });
};
