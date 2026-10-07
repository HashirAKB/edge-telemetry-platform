import type { Logger, LogFields } from './logger.js';
import type { Transport } from './transports/types.js';

export interface LogEntry {
  level: string;
  msg: string;
  fields?: LogFields;
}

export function memoryLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const at =
    (level: string) =>
    (msg: string, fields?: LogFields): void => {
      entries.push(fields ? { level, msg, fields } : { level, msg });
    };
  return { entries, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** Transport whose publish behaviour is scripted per call. */
export class FakeTransport implements Transport {
  readonly name = 'fake';
  readonly published: { topic: string; payload: string }[] = [];
  connected = false;
  closed = false;
  /** Called for every publish; throw to fail it, return a promise to delay it. */
  behaviour: (topic: string, payload: string) => Promise<void> | void = () => undefined;

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  async publish(topic: string, payload: string): Promise<void> {
    await this.behaviour(topic, payload);
    this.published.push({ topic, payload });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
