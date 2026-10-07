import type { Logger } from '../logger.js';
import { withTimeout, type Transport } from './types.js';

export interface MqttSettings {
  /** AWS IoT Core data endpoint (`xxxx-ats.iot.<region>.amazonaws.com`). */
  readonly endpoint: string;
  readonly certPath: string;
  readonly keyPath: string;
  /** Must equal the IoT thing name; the dev device policy only allows that client ID. */
  readonly clientId: string;
  /**
   * Trust anchor for the broker (Amazon Root CA 1). Optional on hosts with a system trust store;
   * required in the slim container image, which has none.
   */
  readonly caPath?: string | undefined;
}

/** The slice of an MQTT 5 client this transport needs; the SDK is adapted to it. */
export interface MqttClientLike {
  onConnectionSuccess(listener: () => void): void;
  onConnectionFailure(listener: (reason: string) => void): void;
  onDisconnection(listener: (reason: string) => void): void;
  onStopped(listener: () => void): void;
  start(): void;
  stop(): void;
  close(): void;
  /** QoS 1 publish; rejects unless the broker acknowledged with a success reason code. */
  publishQos1(topic: string, payload: string): Promise<void>;
}

export interface MqttTransportOptions {
  readonly settings: MqttSettings;
  readonly logger: Logger;
  readonly clientFactory?: (settings: MqttSettings) => Promise<MqttClientLike>;
  readonly connectTimeoutMs?: number;
  readonly publishTimeoutMs?: number;
}

/**
 * Direct MQTT 5 to AWS IoT Core with a dev certificate: local development only (FR-SIM-5).
 * On the edge the simulator publishes through Greengrass IPC instead (Phase 6).
 */
export class MqttTransport implements Transport {
  readonly name = 'mqtt';
  private client: MqttClientLike | undefined;
  private connected = false;

  constructor(private readonly options: MqttTransportOptions) {}

  async connect(): Promise<void> {
    const { settings, logger } = this.options;
    const client = await (this.options.clientFactory ?? createSdkClient)(settings);
    this.client = client;

    const ready = new Promise<void>((resolve) => {
      client.onConnectionSuccess(() => {
        this.connected = true;
        logger.info('mqtt connected', { endpoint: settings.endpoint, clientId: settings.clientId });
        resolve();
      });
    });
    let lastFailure = 'no response';
    client.onConnectionFailure((reason) => {
      lastFailure = reason;
      logger.warn('mqtt connection failed, client will retry', { reason });
    });
    client.onDisconnection((reason) => {
      this.connected = false;
      logger.warn('mqtt disconnected', { reason });
    });

    client.start();
    await withTimeout(ready, this.options.connectTimeoutMs ?? 30_000, 'mqtt connect').catch(
      (error: unknown) => {
        client.stop();
        client.close();
        throw new Error(`${(error as Error).message} (last failure: ${lastFailure})`);
      },
    );
  }

  async publish(topic: string, payload: string): Promise<void> {
    if (!this.client) throw new Error('mqtt transport is not connected');
    // While disconnected the client queues QoS 1 publishes; the timeout hands control back
    // to the publisher's buffer and backoff instead of blocking forever. A retried message
    // may arrive twice, which SiteWise absorbs (same timestamp overwrites, ADR 0004).
    await withTimeout(
      this.client.publishQos1(topic, payload),
      this.options.publishTimeoutMs ?? 10_000,
      `mqtt publish${this.connected ? '' : ' (disconnected)'}`,
    );
  }

  async close(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = undefined;
    const stopped = new Promise<void>((resolve) => {
      client.onStopped(resolve);
    });
    client.stop();
    await withTimeout(stopped, 2_000, 'mqtt stop').catch(() => undefined);
    client.close();
  }
}

/** CRT errors are not always `Error` instances; prefer their message, then their fields. */
function describeCrtError(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : JSON.stringify(error);
}

/** Adapts the AWS IoT Device SDK v2 MQTT 5 client. Loaded lazily: it pulls in native code. */
async function createSdkClient(settings: MqttSettings): Promise<MqttClientLike> {
  const { iot, mqtt5 } = await import('aws-iot-device-sdk-v2');
  const builder = iot.AwsIotMqtt5ClientConfigBuilder.newDirectMqttBuilderWithMtlsFromPath(
    settings.endpoint,
    settings.certPath,
    settings.keyPath,
  );
  if (settings.caPath) builder.withCertificateAuthorityFromPath(undefined, settings.caPath);
  builder.withConnectProperties({ clientId: settings.clientId, keepAliveIntervalSeconds: 60 });
  const client = new mqtt5.Mqtt5Client(builder.build());

  return {
    onConnectionSuccess: (listener) => client.on('connectionSuccess', listener),
    onConnectionFailure: (listener) =>
      client.on('connectionFailure', (event) => {
        listener(describeCrtError(event.error));
      }),
    onDisconnection: (listener) =>
      client.on('disconnection', (event) => {
        listener(describeCrtError(event.error));
      }),
    onStopped: (listener) => client.on('stopped', listener),
    start: () => {
      client.start();
    },
    stop: () => {
      client.stop();
    },
    close: () => {
      client.close();
    },
    publishQos1: async (topic, payload) => {
      const puback = await client.publish({
        topicName: topic,
        payload,
        qos: mqtt5.QoS.AtLeastOnce,
      });
      if (puback && !mqtt5.isSuccessfulPubackReasonCode(puback.reasonCode)) {
        throw new Error(`publish rejected by broker (reason code ${puback.reasonCode})`);
      }
    },
  };
}
