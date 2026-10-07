import { startApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { errorMessage } from './publisher.js';
import { createTransport } from './transports/index.js';

const bootLogger = createLogger('info');

try {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const app = await startApp(config, createTransport(config, logger), logger);

  const onSignal = (signal: NodeJS.Signals): void => {
    void app.shutdown(signal).then(() => process.exit(0));
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
} catch (error) {
  bootLogger.error('failed to start', { error: errorMessage(error) });
  process.exit(1);
}
