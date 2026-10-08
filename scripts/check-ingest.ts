/**
 * Verifies data is flowing end to end into SiteWise (Phase 4 acceptance):
 *   - every machine has fresh measurements, transforms, and 1 minute metrics
 *   - line and site rollups have computed (required with --require-rollups)
 *   - the IoT rule error log is empty for the last 15 minutes
 *
 *   AWS_PROFILE=etp pnpm check:ingest [--require-rollups]
 */
import {
  BatchGetAssetPropertyValueCommand,
  DescribeAssetCommand,
  IoTSiteWiseClient,
  type BatchGetAssetPropertyValueEntry,
} from '@aws-sdk/client-iotsitewise';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import {
  assetExternalIdFor,
  SITEWISE_MODELS,
  topology,
  type ModelType,
  type PropertySpec,
} from '@etp/shared';
import { awsContext } from './lib/context.js';

const requireRollups = process.argv.includes('--require-rollups');
const { region } = await awsContext();
const sitewise = new IoTSiteWiseClient({ region });
const logs = new CloudWatchLogsClient({ region });

/** How old a value may be before it counts as missing, by property kind and window. */
function maxAgeSeconds(spec: PropertySpec): number | undefined {
  if (spec.kind === 'measurement' || spec.kind === 'transform') return 60;
  if (spec.kind === 'metric') return spec.window === '1m' ? 180 : 660;
  return undefined; // attributes have no timestamp worth checking
}

interface Row {
  asset: string;
  property: string;
  kind: string;
  value: string;
  ageSeconds: number | undefined;
  ok: boolean;
  required: boolean;
}

const nodes: { externalId: string; type: ModelType }[] = [
  { externalId: assetExternalIdFor(topology.site.id), type: 'site' },
  ...topology.lines.flatMap((line) => [
    { externalId: assetExternalIdFor(topology.site.id, line.id), type: 'line' as const },
    ...line.machines.map((m) => ({
      externalId: assetExternalIdFor(topology.site.id, line.id, m.id),
      type: m.type,
    })),
  ]),
];

const rows: Row[] = [];
const now = Date.now() / 1000;

for (const node of nodes) {
  const asset = await sitewise.send(
    new DescribeAssetCommand({ assetId: `externalId:${node.externalId}` }),
  );
  const specs = SITEWISE_MODELS[node.type].properties;
  const properties = (asset.assetProperties ?? []).filter((p) => p.id && p.name);
  const entries: BatchGetAssetPropertyValueEntry[] = properties.map((p, i) => ({
    entryId: `e${i}`,
    assetId: asset.assetId,
    propertyId: p.id,
  }));

  const values = new Map<string, { value: string; time: number }>();
  for (let i = 0; i < entries.length; i += 128) {
    const result = await sitewise.send(
      new BatchGetAssetPropertyValueCommand({ entries: entries.slice(i, i + 128) }),
    );
    for (const success of result.successEntries ?? []) {
      const tqv = success.assetPropertyValue;
      const v = tqv?.value;
      if (!tqv?.timestamp?.timeInSeconds || !v || !success.entryId) continue;
      const raw = v.doubleValue ?? v.stringValue ?? v.integerValue ?? v.booleanValue;
      values.set(success.entryId, {
        value: typeof raw === 'number' ? raw.toFixed(2) : String(raw),
        time: tqv.timestamp.timeInSeconds,
      });
    }
  }

  properties.forEach((p, i) => {
    const spec = specs.find((s) => s.name === p.name);
    if (!spec) return;
    const found = values.get(`e${i}`);
    const limit = maxAgeSeconds(spec);
    const ageSeconds = found ? Math.round(now - found.time) : undefined;
    const fresh = limit === undefined || (ageSeconds !== undefined && ageSeconds <= limit);
    const isRollup = node.type === 'line' || node.type === 'site';
    const isSlowMetric = spec.kind === 'metric' && spec.window !== '1m';
    rows.push({
      asset: node.externalId,
      property: spec.name,
      kind: spec.kind,
      value: found?.value ?? '-',
      ageSeconds,
      ok: fresh,
      // Machine 5 minute metrics and rollups need up to ~10 minutes of data before they appear.
      required: limit !== undefined && (isRollup || isSlowMetric ? requireRollups : true),
    });
  });
}

for (const row of rows) {
  const status = row.ok ? 'ok  ' : row.required ? 'FAIL' : 'wait';
  const age = row.ageSeconds === undefined ? '' : `${row.ageSeconds}s ago`;
  console.log(
    `${status} ${row.asset.padEnd(24)} ${row.property.padEnd(30)} ${row.kind.padEnd(11)} ${row.value.padStart(9)}  ${age}`,
  );
}

const errors = await logs.send(
  new FilterLogEventsCommand({
    logGroupName: '/etp/iot/rule-errors',
    startTime: Date.now() - 15 * 60_000,
    limit: 5,
  }),
);
const errorCount = errors.events?.length ?? 0;
console.log(`\nIoT rule errors in the last 15 minutes: ${errorCount}`);
for (const event of errors.events ?? []) console.log(`  ${event.message?.slice(0, 300) ?? ''}`);

const failures = rows.filter((r) => r.required && !r.ok);
const waiting = rows.filter((r) => !r.required && !r.ok).length;
console.log(
  `${rows.length - failures.length - waiting}/${rows.length} properties fresh, ` +
    `${failures.length} failing, ${waiting} still waiting for their first window`,
);
process.exit(failures.length > 0 || errorCount > 0 ? 1 : 0);
