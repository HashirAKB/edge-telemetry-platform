// Placeholder entry point. Signals, faults, and transports arrive in Phase 3.
import { CONTRACT_VERSION } from '@etp/shared';

export function telemetryTopicPrefix(): string {
  return `telemetry/v${CONTRACT_VERSION}`;
}
