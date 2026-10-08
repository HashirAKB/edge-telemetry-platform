import { createHandler } from '../http/app.js';
import { telemetryRoutes } from '../routes.js';
import { createRuntime } from '../runtime.js';
import { TelemetryService } from '../services/telemetry.js';

const { logger, metrics, catalog, reader } = createRuntime('telemetry-query');
const telemetry = new TelemetryService(catalog, reader, {
  publishIntervalMs: Number(process.env.PUBLISH_INTERVAL_MS ?? 5000),
});

export const handler = createHandler({
  service: 'telemetry-query',
  routes: telemetryRoutes(telemetry),
  logger,
  metrics,
});
