import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { API_ROUTES, PROBLEM_CONTENT_TYPE, type ApiService, type Problem } from '@etp/shared';
import { ApiError } from './errors.js';

export interface RequestInput {
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly query: Readonly<Record<string, string | undefined>>;
}

export type RouteImpl = (input: RequestInput) => Promise<unknown>;

/** The slices of Powertools Logger and Metrics this module uses (fakes in tests). */
export interface AppLogger {
  addContext(context: Context): void;
  appendKeys(keys: Record<string, unknown>): void;
  resetKeys(): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}
export interface AppMetrics {
  addDimension(name: string, value: string): void;
  addMetric(name: string, unit: 'Count' | 'Milliseconds', value: number): void;
  publishStoredMetrics(): void;
}

export interface AppOptions {
  readonly service: ApiService;
  /** Implementations keyed by route ID (`FR-API-n`); each must belong to `service`. */
  readonly routes: Readonly<Record<string, RouteImpl>>;
  readonly logger: AppLogger;
  readonly metrics: AppMetrics;
}

const CORS = { 'access-control-allow-origin': '*' };

function respond(
  status: number,
  body: unknown,
  contentType = 'application/json',
): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { 'content-type': contentType, 'cache-control': 'no-store', ...CORS },
    body: JSON.stringify(body),
  };
}

function problem(error: ApiError, instance: string): APIGatewayProxyResult {
  const body: Problem = {
    type: 'about:blank',
    title: error.title,
    status: error.status,
    instance,
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.errors ? { errors: [...error.errors] } : {}),
  };
  return respond(error.status, body, PROBLEM_CONTENT_TYPE);
}

function isThrottling(error: unknown): boolean {
  return error instanceof Error && error.name === 'ThrottlingException';
}

/**
 * Thin Lambda handler (FR-API-11): find the route, run it, map errors to problem+json, and record
 * logs and metrics. All parsing and business logic live in the route implementations.
 */
export function createHandler(options: AppOptions) {
  const routes = API_ROUTES.filter((r) => r.service === options.service);
  for (const route of routes) {
    if (!(route.id in options.routes)) throw new Error(`No implementation for ${route.id}`);
  }
  const { logger, metrics } = options;

  return async (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> => {
    const started = Date.now();
    logger.addContext(context);
    logger.appendKeys({ correlationId: event.requestContext.requestId });
    const route = routes.find(
      (r) => r.path === event.resource && r.method === event.httpMethod.toLowerCase(),
    );
    const routeId = route?.id ?? 'unknown';
    metrics.addDimension('route', routeId);

    let response: APIGatewayProxyResult;
    try {
      if (!route)
        throw new ApiError(404, 'Not Found', `No route for ${event.httpMethod} ${event.resource}`);
      const impl = options.routes[route.id];
      if (!impl) throw new Error(`No implementation for ${route.id}`);
      const body = await impl({
        params: event.pathParameters ?? {},
        query: event.queryStringParameters ?? {},
      });
      response = respond(200, body);
    } catch (error) {
      if (error instanceof ApiError) {
        response = problem(error, event.path);
      } else if (isThrottling(error)) {
        logger.warn('SiteWise throttled the request', { error });
        response = problem(
          new ApiError(503, 'Service Unavailable', 'Upstream is busy; retry shortly'),
          event.path,
        );
        response.headers = { ...response.headers, 'retry-after': '1' };
      } else {
        // Never leak internals to the client; the correlation ID ties the log to the request.
        logger.error('Unhandled error', { error });
        response = problem(
          new ApiError(500, 'Internal Server Error', 'Unexpected error'),
          event.path,
        );
      }
    } finally {
      logger.info('request', {
        route: routeId,
        path: event.path,
        durationMs: Date.now() - started,
      });
      logger.resetKeys();
    }

    metrics.addMetric('Requests', 'Count', 1);
    if (response.statusCode >= 500) metrics.addMetric('ServerErrors', 'Count', 1);
    else if (response.statusCode >= 400) metrics.addMetric('ClientErrors', 'Count', 1);
    metrics.addMetric('Latency', 'Milliseconds', Date.now() - started);
    metrics.publishStoredMetrics();
    return response;
  };
}
