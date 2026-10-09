/**
 * Custom metric names shared by the Lambdas that publish them and the alarms and dashboard that
 * read them (FR-OBS-1, FR-OBS-2). A mismatch would make an alarm watch a metric that never exists.
 */
export const METRICS_NAMESPACE = 'EdgeTelemetryPlatform';
export const FRESHNESS_SERVICE = 'freshness-monitor';
export const FRESHNESS_METRIC = 'SecondsSinceLastValue';

/** A machine is stale after 120 s without a value, for 3 consecutive minutes (FR-OBS-3). */
export const STALE_THRESHOLD_SECONDS = 120;
export const STALE_EVALUATION_MINUTES = 3;
