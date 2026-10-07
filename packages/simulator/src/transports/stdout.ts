import type { Transport } from './types.js';

/** Prints one JSON line per message: `{"topic": ..., "payload": {...}}`. No AWS needed. */
export class StdoutTransport implements Transport {
  readonly name = 'stdout';

  constructor(
    private readonly write: (line: string) => void = (line) => process.stdout.write(line),
  ) {}

  connect(): Promise<void> {
    return Promise.resolve();
  }

  publish(topic: string, payload: string): Promise<void> {
    this.write(`{"topic":${JSON.stringify(topic)},"payload":${payload}}\n`);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
