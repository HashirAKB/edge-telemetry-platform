import type { SimulatorConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { IpcTransport, type IpcClientLike } from './ipc.js';
import { MqttTransport, type MqttTransportOptions } from './mqtt.js';
import { StdoutTransport } from './stdout.js';
import type { Transport } from './types.js';

export type { Transport } from './types.js';

export function createTransport(
  config: SimulatorConfig,
  logger: Logger,
  mqttOverrides: Partial<MqttTransportOptions> = {},
  ipcClient?: IpcClientLike,
): Transport {
  switch (config.transport) {
    case 'stdout':
      return new StdoutTransport();
    case 'mqtt': {
      if (!config.mqtt) throw new Error('TRANSPORT=mqtt requires mqtt settings');
      return new MqttTransport({ settings: config.mqtt, logger, ...mqttOverrides });
    }
    case 'ipc': {
      if (!ipcClient) throw new Error('TRANSPORT=ipc requires a Greengrass IPC client');
      return new IpcTransport(ipcClient, logger);
    }
  }
}
