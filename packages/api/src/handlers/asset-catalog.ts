import { createHandler } from '../http/app.js';
import { catalogRoutes } from '../routes.js';
import { createRuntime } from '../runtime.js';

const { logger, metrics, catalog } = createRuntime('asset-catalog');

export const handler = createHandler({
  service: 'asset-catalog',
  routes: catalogRoutes(catalog, process.env.BUILD_VERSION ?? 'dev'),
  logger,
  metrics,
});
