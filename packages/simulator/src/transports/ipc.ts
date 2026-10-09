import type { Logger } from '../logger.js';
import { withTimeout, type Transport } from './types.js';

/** Key under the component configuration that holds the simulator settings (FR-SIM-6). */
export const GREENGRASS_CONFIG_KEY = 'simulator';

/** The slice of the Greengrass IPC client the simulator needs; the SDK is adapted to it. */
export interface IpcClientLike {
  connect(): Promise<void>;
  close(): Promise<void>;
  /** PublishToIoTCore with QoS 1; resolves once the nucleus has accepted (and spooled) it. */
  publishQos1(topic: string, payload: string): Promise<void>;
  /** This component's configuration at `keyPath`, or undefined when not set. */
  getConfiguration(keyPath: string[]): Promise<unknown>;
  /** Calls `listener` whenever this component's configuration under `keyPath` changes. */
  onConfigurationUpdate(keyPath: string[], listener: () => void): Promise<void>;
}

/**
 * Publishes through the Greengrass nucleus over IPC (FR-SIM-5, the production path). The nucleus
 * owns the MQTT connection and the disk spooler, so network outages never reach this process;
 * a failure here means the nucleus itself is unavailable (for example restarting).
 */
export class IpcTransport implements Transport {
  readonly name = 'ipc';

  constructor(
    private readonly client: IpcClientLike,
    private readonly logger: Logger,
    private readonly publishTimeoutMs = 10_000,
  ) {}

  /** The client is connected by main.ts before config is read, so this only logs. */
  connect(): Promise<void> {
    this.logger.info('publishing through greengrass ipc');
    return Promise.resolve();
  }

  publish(topic: string, payload: string): Promise<void> {
    return withTimeout(
      this.client.publishQos1(topic, payload),
      this.publishTimeoutMs,
      'ipc publish',
    );
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

/**
 * Adapts the AWS IoT Device SDK v2 Greengrass IPC client. It reads the socket path and SVCUID
 * that the nucleus passes into the container (see the component recipe). Loaded lazily.
 */
export async function createSdkIpcClient(): Promise<IpcClientLike> {
  const { greengrasscoreipc } = await import('aws-iot-device-sdk-v2');
  const { model } = greengrasscoreipc;
  const client = greengrasscoreipc.createClient();
  return {
    connect: () => client.connect(),
    close: () => client.close(),
    publishQos1: async (topic, payload) => {
      await client.publishToIoTCore({
        topicName: topic,
        qos: model.QOS.AT_LEAST_ONCE,
        payload,
      });
    },
    getConfiguration: async (keyPath) => {
      const response = await client.getConfiguration({ keyPath });
      return response.value as unknown;
    },
    onConfigurationUpdate: async (keyPath, listener) => {
      const operation = client.subscribeToConfigurationUpdate({ keyPath });
      operation.on('message', () => {
        listener();
      });
      await operation.activate();
    },
  };
}
