export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/**
 * Structured JSON-lines logger (FR-SIM-9). Logs go to stderr so stdout stays a clean stream of
 * telemetry in `stdout` transport mode; Greengrass captures both streams into the component log.
 */
export function createLogger(
  level: LogLevel = 'info',
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  base: LogFields = {},
): Logger {
  const log = (lvl: LogLevel, msg: string, fields?: LogFields): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...base, ...fields }));
  };
  return {
    debug: (msg, fields) => {
      log('debug', msg, fields);
    },
    info: (msg, fields) => {
      log('info', msg, fields);
    },
    warn: (msg, fields) => {
      log('warn', msg, fields);
    },
    error: (msg, fields) => {
      log('error', msg, fields);
    },
  };
}

export function isLogLevel(value: string): value is LogLevel {
  return value in ORDER;
}
