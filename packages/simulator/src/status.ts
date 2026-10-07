import {
  OVERHEAT_THRESHOLD_C,
  VIBRATION_ALERT_THRESHOLD_MM_S,
  type MachineStatus,
  type MachineType,
} from '@etp/shared';
import type { FaultSpec, Metrics } from './faults.js';

export interface StatusInput {
  readonly type: MachineType;
  readonly idle: boolean;
  readonly activeFaults: readonly FaultSpec[];
  readonly values: Metrics;
}

/**
 * FR-SIM-4: FAULT when an active fault has pushed its signal past the threshold, IDLE during
 * idle windows, RUNNING otherwise. A stuck sensor deliberately stays RUNNING: in real plants
 * a frozen value looks healthy, and detecting it is a cloud analytics problem.
 */
export function deriveStatus(input: StatusInput): MachineStatus {
  const crossed = input.activeFaults.some((fault) => {
    switch (fault.kind) {
      case 'bearingWear':
        return (input.values.vibration_mm_s ?? 0) > VIBRATION_ALERT_THRESHOLD_MM_S;
      case 'overheat':
        return (input.values.temperature_c ?? 0) > OVERHEAT_THRESHOLD_C[input.type];
      case 'stuckSensor':
      case 'dropout':
        return false;
    }
  });
  if (crossed) return 'FAULT';
  return input.idle ? 'IDLE' : 'RUNNING';
}
