/**
 * SRS 13.3: the key offline-buffering demo. Blocks the core's outbound MQTT (port 8883 only, so
 * SSM keeps working) for 2 minutes, restores it, waits for the spooled messages to replay, then
 * checks SiteWise history for pump-01: no gap longer than 2 x the publish interval, and one
 * point per interval. With --restart, Greengrass is also restarted mid-outage, which proves the
 * spool survives on disk.
 *
 *   AWS_PROFILE=etp pnpm edge:outage-test [--restart]
 */
import {
  GetAssetPropertyValueHistoryCommand,
  IoTSiteWiseClient,
} from '@aws-sdk/client-iotsitewise';
import { aliasFor, DEFAULT_PUBLISH_INTERVAL_MS } from '@etp/shared';
import { runOnInstance, stackOutputs } from './lib/aws.js';
import { awsContext, fail } from './lib/context.js';

const RESTART = process.argv.includes('--restart');
const OUTAGE_SECONDS = 120;
const INTERVAL_MS = DEFAULT_PUBLISH_INTERVAL_MS;
const ALIAS = aliasFor('kochi-01', 'line-a', 'pump-01', 'temperature_c');

const { region } = await awsContext();
const { InstanceId: instanceId } = await stackOutputs(region, 'EtpEdgeHost');
if (!instanceId) fail('EtpEdgeHost has no InstanceId output');

const blockScript = `
set -u
restore() { iptables -D OUTPUT -p tcp --dport 8883 -j DROP 2>/dev/null || true; }
trap restore EXIT
iptables -I OUTPUT -p tcp --dport 8883 -j DROP
echo "blocked $(date -u +%FT%TZ)"
${
  RESTART
    ? `sleep 30; systemctl restart greengrass; echo "greengrass restarted $(date -u +%FT%TZ)"; sleep ${String(OUTAGE_SECONDS - 30)}`
    : `sleep ${String(OUTAGE_SECONDS)}`
}
restore
echo "restored $(date -u +%FT%TZ)"
`;

const t0 = Date.now();
console.log(`outage ${RESTART ? 'with Greengrass restart ' : ''}starting on ${instanceId}`);
console.log(await runOnInstance(region, instanceId, blockScript, OUTAGE_SECONDS + 120));
const t1 = Date.now();

// Check a window that starts before the outage and ends after it, once replay has caught up.
const windowStart = new Date(t0 - 30_000);
const windowEnd = new Date(t1 + 30_000);
const sitewise = new IoTSiteWiseClient({ region });

async function history(): Promise<number[]> {
  const stamps: number[] = [];
  let nextToken: string | undefined;
  do {
    const page = await sitewise.send(
      new GetAssetPropertyValueHistoryCommand({
        propertyAlias: ALIAS,
        startDate: new Date(Math.floor(windowStart.getTime() / 1000) * 1000),
        endDate: new Date(Math.ceil(windowEnd.getTime() / 1000) * 1000),
        maxResults: 1000,
        nextToken,
      }),
    );
    for (const v of page.assetPropertyValueHistory ?? []) {
      const t = v.timestamp;
      if (t?.timeInSeconds !== undefined)
        stamps.push(t.timeInSeconds * 1000 + Math.floor((t.offsetInNanos ?? 0) / 1e6));
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return stamps.sort((a, b) => a - b);
}

function maxGap(stamps: number[]): number {
  let gap = 0;
  for (let i = 1; i < stamps.length; i++)
    gap = Math.max(gap, (stamps[i] ?? 0) - (stamps[i - 1] ?? 0));
  return gap;
}

// Replay can take a minute or two after reconnecting; poll until the window is complete.
console.log('waiting for spooled messages to replay into SiteWise...');
const expected = Math.floor((windowEnd.getTime() - windowStart.getTime()) / INTERVAL_MS);
let stamps: number[];
const deadline = Date.now() + 4 * 60_000;
do {
  await new Promise((r) => setTimeout(r, 15_000));
  stamps = await history();
  console.log(
    `  ${String(stamps.length)}/${String(expected)} points, max gap ${String(maxGap(stamps) / 1000)} s`,
  );
} while (
  (maxGap(stamps) > 2 * INTERVAL_MS || stamps.length < expected - 1) &&
  Date.now() < deadline
);

const gap = maxGap(stamps);
const noGap = gap <= 2 * INTERVAL_MS;
const complete = stamps.length >= expected - 1;
console.log(
  `\n${noGap ? 'PASS' : 'FAIL'}  largest gap ${String(gap / 1000)} s (limit ${String((2 * INTERVAL_MS) / 1000)} s)`,
);
console.log(
  `${complete ? 'PASS' : 'FAIL'}  ${String(stamps.length)} points for ${String(expected)} intervals (window ${windowStart.toISOString()} to ${windowEnd.toISOString()})`,
);

const log = await runOnInstance(
  region,
  instanceId,
  // Match real problems only: the graceful-shutdown summary always contains "dropped":0.
  'grep -hE \'buffer full|"dropped":[1-9]|"unsent":[1-9]|failed to start\' /greengrass/v2/logs/com.hashirakb.etp.SensorSimulator.log | tail -5 || true',
  60,
);
console.log(`component log drops/failures: ${log.trim() === '' ? 'none' : `\n${log}`}`);
process.exit(noGap && complete && log.trim() === '' ? 0 : 1);
