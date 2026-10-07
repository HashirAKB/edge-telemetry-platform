/** Where messages go (FR-SIM-5). `publish` resolves only once delivery is acknowledged. */
export interface Transport {
  readonly name: string;
  connect(): Promise<void>;
  publish(topic: string, payload: string): Promise<void>;
  close(): Promise<void>;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
