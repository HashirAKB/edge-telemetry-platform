import { startApp, type App } from './app.js';
import { loadConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { errorMessage } from './publisher.js';
import { createTransport } from './transports/index.js';
import { createSdkIpcClient, GREENGRASS_CONFIG_KEY, type IpcClientLike } from './transports/ipc.js';

const bootLogger = createLogger('info');

/**
 * Under Greengrass (TRANSPORT=ipc) the component configuration is read over IPC and a
 * configuration merge is applied live (FR-SIM-6, FR-EDGE-4). An invalid update is logged and
 * ignored, so a bad deployment cannot stop a running simulator.
 */
async function watchGreengrassConfig(ipc: IpcClientLike, app: App, logger: Logger): Promise<void> {
  await ipc.onConfigurationUpdate([GREENGRASS_CONFIG_KEY], () => {
    void (async () => {
      try {
        const greengrass = await ipc.getConfiguration([GREENGRASS_CONFIG_KEY]);
        app.reconfigure(loadConfig(process.env, undefined, greengrass));
      } catch (error) {
        logger.error('configuration update rejected', { error: errorMessage(error) });
      }
    })();
  });
}

try {
  let ipc: IpcClientLike | undefined;
  let greengrass: unknown;
  if (process.env.TRANSPORT === 'ipc') {
    ipc = await createSdkIpcClient();
    await ipc.connect();
    greengrass = await ipc.getConfiguration([GREENGRASS_CONFIG_KEY]);
  }

  const config = loadConfig(process.env, undefined, greengrass);
  const logger = createLogger(config.logLevel);
  const transport = createTransport(config, logger, {}, ipc);
  const app = await startApp(config, transport, logger);
  if (ipc) await watchGreengrassConfig(ipc, app, logger);

  const onSignal = (signal: NodeJS.Signals): void => {
    void app.shutdown(signal).then(() => process.exit(0));
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
} catch (error) {
  bootLogger.error('failed to start', { error: errorMessage(error) });
  process.exit(1);
}
