import type { SimulatorConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { MqttTransport, type MqttTransportOptions } from './mqtt.js';
import { StdoutTransport } from './stdout.js';
import type { Transport } from './types.js';

export type { Transport } from './types.js';

export function createTransport(
  config: SimulatorConfig,
  logger: Logger,
  mqttOverrides: Partial<MqttTransportOptions> = {},
): Transport {
  switch (config.transport) {
    case 'stdout':
      return new StdoutTransport();
    case 'mqtt': {
      if (!config.mqtt) throw new Error('TRANSPORT=mqtt requires mqtt settings');
      return new MqttTransport({ settings: config.mqtt, logger, ...mqttOverrides });
    }
  }
}
