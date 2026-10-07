import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { createTransport } from './transports/index.js';
import { MqttTransport, type MqttClientLike, type MqttSettings } from './transports/mqtt.js';
import { StdoutTransport } from './transports/stdout.js';
import { memoryLogger } from './test-helpers.js';

const settings: MqttSettings = {
  endpoint: 'abc-ats.iot.ap-south-1.amazonaws.com',
  certPath: 'c',
  keyPath: 'k',
  clientId: 'dev',
};

/** Scriptable stand-in for the SDK client. */
class FakeMqttClient implements MqttClientLike {
  readonly listeners: Record<string, ((arg: string) => void)[]> = {};
  started = false;
  closed = false;
  autoConnect = true;
  publishImpl: (topic: string, payload: string) => Promise<void> = () => Promise.resolve();

  private add(event: string, l: (arg: string) => void): void {
    (this.listeners[event] ??= []).push(l);
  }
  emit(event: string, arg = ''): void {
    for (const l of this.listeners[event] ?? []) l(arg);
  }
  onConnectionSuccess(l: () => void): void {
    this.add('success', l);
  }
  onConnectionFailure(l: (r: string) => void): void {
    this.add('failure', l);
  }
  onDisconnection(l: (r: string) => void): void {
    this.add('disconnect', l);
  }
  onStopped(l: () => void): void {
    this.add('stopped', l);
  }
  start(): void {
    this.started = true;
    if (this.autoConnect) {
      queueMicrotask(() => {
        this.emit('success');
      });
    }
  }
  stop(): void {
    queueMicrotask(() => {
      this.emit('stopped');
    });
  }
  close(): void {
    this.closed = true;
  }
  publishQos1(topic: string, payload: string): Promise<void> {
    return this.publishImpl(topic, payload);
  }
}

describe('StdoutTransport', () => {
  it('prints one JSON line with topic and payload', async () => {
    const lines: string[] = [];
    const t = new StdoutTransport((l) => lines.push(l));
    await t.connect();
    await t.publish('telemetry/v1/a', '{"v":1}');
    await t.close();
    expect(lines).toEqual(['{"topic":"telemetry/v1/a","payload":{"v":1}}\n']);
  });
});

describe('MqttTransport', () => {
  let client: FakeMqttClient;
  let logger: ReturnType<typeof memoryLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new FakeMqttClient();
    logger = memoryLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const make = () =>
    new MqttTransport({ settings, logger, clientFactory: () => Promise.resolve(client) });

  it('connects, publishes with QoS 1, and closes cleanly', async () => {
    const sent: string[] = [];
    client.publishImpl = (topic) => {
      sent.push(topic);
      return Promise.resolve();
    };
    const t = make();
    await t.connect();
    await t.publish('telemetry/v1/x', '{}');
    const closing = t.close();
    await vi.runAllTimersAsync();
    await closing;
    expect(sent).toEqual(['telemetry/v1/x']);
    expect(client.closed).toBe(true);
    expect(logger.entries.map((e) => e.msg)).toContain('mqtt connected');
  });

  it('fails connect after the timeout and reports the last failure', async () => {
    client.autoConnect = false;
    const t = new MqttTransport({
      settings,
      logger,
      clientFactory: () => Promise.resolve(client),
      connectTimeoutMs: 1_000,
    });
    const connecting = t.connect();
    const assertion = expect(connecting).rejects.toThrow(/last failure: TLS handshake failed/);
    await vi.advanceTimersByTimeAsync(0);
    client.emit('failure', 'TLS handshake failed');
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(client.closed).toBe(true);
  });

  it('times out a publish that hangs while disconnected', async () => {
    client.publishImpl = () => new Promise(() => undefined);
    const t = new MqttTransport({
      settings,
      logger,
      clientFactory: () => Promise.resolve(client),
      publishTimeoutMs: 2_000,
    });
    await t.connect();
    client.emit('disconnect', 'network down');
    const publishing = t.publish('t', '{}');
    const assertion = expect(publishing).rejects.toThrow(/disconnected\) timed out after 2000 ms/);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
  });

  it('refuses to publish before connect, and close is a no-op', async () => {
    const t = make();
    await expect(t.publish('t', '{}')).rejects.toThrow(/not connected/);
    await expect(t.close()).resolves.toBeUndefined();
  });
});

describe('createTransport (FR-SIM-5)', () => {
  const logger = memoryLogger();

  it('selects the transport from config', () => {
    expect(createTransport(loadConfig({}), logger).name).toBe('stdout');
    const mqtt = loadConfig({
      TRANSPORT: 'mqtt',
      IOT_ENDPOINT: 'e',
      CERT_PATH: 'c',
      KEY_PATH: 'k',
      CLIENT_ID: 'id',
    });
    expect(createTransport(mqtt, logger).name).toBe('mqtt');
  });

  it('guards against mqtt without settings', () => {
    const config = { ...loadConfig({}), transport: 'mqtt' as const };
    expect(() => createTransport(config, logger)).toThrow(/requires mqtt settings/);
  });
});
