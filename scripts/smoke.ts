/**
 * FR-DX-4 / SRS 13.1 and 13.4: end-to-end checks against the deployed query API, plus latency
 * percentiles for NFR-1. Needs the simulator to have run recently.
 *
 *   AWS_PROFILE=etp pnpm smoke [--min-points 10]
 */
import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  API_KEY_HEADER,
  PROBLEM_CONTENT_TYPE,
  type AssetDetail,
  type AssetTreeNode,
  type AssetTreeResponse,
  type AggregatesResponse,
  type LatestValuesResponse,
} from '@etp/shared';
import { awsContext, fail } from './lib/context.js';

const minPointsArg = process.argv.indexOf('--min-points');
const MIN_POINTS = minPointsArg > 0 ? Number(process.argv[minPointsArg + 1]) : 10;

const { region } = await awsContext();
const stack = await new CloudFormationClient({ region }).send(
  new DescribeStacksCommand({ StackName: 'EtpApi' }),
);
const outputs = Object.fromEntries(
  (stack.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']),
);
const baseUrl = (outputs.ApiUrl ?? '').replace(/\/$/, '');
if (!baseUrl || !outputs.ApiKeyId) fail('EtpApi outputs not found; is the stack deployed?');
const key = await new APIGatewayClient({ region }).send(
  new GetApiKeyCommand({ apiKey: outputs.ApiKeyId, includeValue: true }),
);
const apiKey = key.value ?? fail('could not read the API key value');
console.log(`API ${baseUrl}\n`);

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures += 1;
}

interface Result<T> {
  status: number;
  contentType: string;
  body: T;
  ms: number;
}
async function get<T>(path: string, withKey = true): Promise<Result<T>> {
  const started = performance.now();
  const res = await fetch(`${baseUrl}${path}`, {
    headers: withKey ? { [API_KEY_HEADER]: apiKey } : {},
  });
  const text = await res.text();
  const ms = performance.now() - started;
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    body: body as T,
    ms,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const now = () => new Date().toISOString();

// --- Auth (SRS 13.4) --------------------------------------------------------------------
const health = await get<{ status: string; version: string }>('/v1/health', false);
check(
  health.status === 200 && health.body.status === 'ok',
  'health without a key',
  JSON.stringify(health.body),
);
const noKey = await get('/v1/assets/tree', false);
check(noKey.status === 403, 'tree without a key is rejected', `HTTP ${String(noKey.status)}`);

// --- Catalog (13.1 step 1) --------------------------------------------------------------
const tree = await get<AssetTreeResponse>('/v1/assets/tree');
const all: AssetTreeNode[] = [];
const walk = (n: AssetTreeNode) => {
  all.push(n);
  n.children.forEach(walk);
};
if (tree.status === 200) walk(tree.body.site);
const counts = ['site', 'line', 'pump', 'compressor'].map(
  (t) => all.filter((n) => n.type === t).length,
);
check(
  counts.join(',') === '1,2,3,2',
  'tree has 1 site, 2 lines, 5 machines',
  `site,line,pump,compressor = ${counts.join(',')}`,
);
const aliased = all.flatMap((n) => n.properties).filter((p) => p.alias).length;
check(aliased === 25, 'every measurement has its alias', `${String(aliased)} aliases`);

const byKey = await get<AssetDetail>('/v1/assets/by-key/kochi-01/line-a/pump-01');
check(byKey.status === 200, 'by-key resolves pump-01', byKey.body.assetId);
const pump = byKey.body;
const propertyId = (name: string) => pump.properties.find((p) => p.name === name)?.propertyId ?? '';

// --- Latest values (13.1 step 2) --------------------------------------------------------
const latest = await get<LatestValuesResponse>(`/v1/assets/${pump.assetId}/latest`);
check(
  latest.status === 200 && !latest.body.stale,
  'pump-01 latest values are fresh',
  `newest ${latest.body.newestMeasurementAt ?? 'none'}`,
);
// A transform lands a few seconds after its input, so compare values at the same timestamp.
interface HistoryBody {
  values?: { timestamp: string; value: unknown }[];
}
const historyOf = (name: string) =>
  get<HistoryBody>(
    `/v1/assets/${pump.assetId}/properties/${propertyId(name)}/history?from=${minutesAgo(2)}&to=${now()}&limit=100`,
  );
const [celsius, fahrenheit] = await Promise.all([
  historyOf('temperature_c'),
  historyOf('temperature_f'),
]);
const fByTime = new Map((fahrenheit.body.values ?? []).map((v) => [v.timestamp, v.value]));
const pairs = (celsius.body.values ?? [])
  .filter((v) => fByTime.has(v.timestamp))
  .map((v) => [Number(v.value), Number(fByTime.get(v.timestamp))] as const);
const mismatched = pairs.filter(([c, f]) => Math.abs(c * 1.8 + 32 - f) >= 0.01);
check(
  pairs.length > 0 && mismatched.length === 0,
  'temperature_f equals temperature_c * 9/5 + 32 at every shared timestamp',
  `${String(pairs.length)} pairs, ${String(mismatched.length)} mismatched`,
);

// --- Aggregates (13.1 step 3) -----------------------------------------------------------
const aggs = await get<AggregatesResponse>(
  `/v1/assets/${pump.assetId}/properties/${propertyId('temperature_c')}/aggregates?from=${minutesAgo(30)}&to=${now()}&resolution=1m&types=AVERAGE,MAXIMUM`,
);
const points = aggs.status === 200 ? aggs.body.points : [];
check(
  aggs.status === 200 && points.length >= MIN_POINTS,
  `1m aggregates over 30 min (need >= ${String(MIN_POINTS)})`,
  aggs.status === 200
    ? `${String(points.length)} points`
    : `HTTP ${String(aggs.status)} ${JSON.stringify(aggs.body).slice(0, 300)}`,
);
check(
  points.length > 0 &&
    points.every(
      (p) => typeof p.values.AVERAGE === 'number' && typeof p.values.MAXIMUM === 'number',
    ),
  'each point has AVERAGE and MAXIMUM',
);

// --- Rollup (13.1 step 4) ---------------------------------------------------------------
const lineA = all.find((n) => n.externalKey === 'kochi-01/line-a');
if (lineA) {
  const lineLatest = await get<LatestValuesResponse>(`/v1/assets/${lineA.assetId}/latest`);
  const lineMax = lineLatest.body.values.find((v) => v.name === 'line_max_vibration_5m');
  const children = await Promise.all(
    lineA.children.map((m) => get<LatestValuesResponse>(`/v1/assets/${m.assetId}/latest`)),
  );
  const childMaxes = children
    .map((r) => r.body.values.find((v) => v.name === 'max_vibration_5m'))
    .filter((v) => v?.timestamp === lineMax?.timestamp && typeof v?.value === 'number')
    .map((v) => v?.value as number);
  check(
    childMaxes.length === lineA.children.length && lineMax?.value === Math.max(...childMaxes),
    'line-a max vibration equals the max of its machines (same window)',
    `line ${String(lineMax?.value)} vs machines ${childMaxes.join(', ')}`,
  );
}

// --- Errors (FR-API-5, problem+json) ----------------------------------------------------
const bad = await get<{ status: number }>('/v1/assets/not-a-uuid');
check(
  bad.status === 400 && bad.contentType.startsWith(PROBLEM_CONTENT_TYPE),
  'invalid asset id -> 400 problem+json',
);
const missing = await get('/v1/assets/bbbbbbbb-0000-4000-8000-000000000001/latest');
check(missing.status === 404, 'asset outside the site -> 404');
const tooLong = await get(
  `/v1/assets/${pump.assetId}/properties/${propertyId('temperature_c')}/history?from=${minutesAgo(60 * 25)}&to=${now()}`,
);
check(tooLong.status === 400, 'history range over 24 h -> 400');

// --- Latency (NFR-1) --------------------------------------------------------------------
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}
async function measure(label: string, path: string, n: number, budgetMs: number): Promise<void> {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    samples.push((await get(path)).ms);
    await sleep(150); // stay well under the 10 rps usage plan
  }
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  check(
    p95 < budgetMs,
    `${label} p95 under ${String(budgetMs)} ms`,
    `p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms (n=${String(n)})`,
  );
}
console.log('');
await measure('tree (warm, cached)', '/v1/assets/tree', 20, 500);
await measure('latest', `/v1/assets/${pump.assetId}/latest`, 20, 500);
await measure(
  'aggregates 24 h at 1m',
  `/v1/assets/${pump.assetId}/properties/${propertyId('temperature_c')}/aggregates?from=${minutesAgo(24 * 60 - 1)}&to=${now()}&resolution=1m`,
  10,
  1500,
);

console.log(`\n${failures === 0 ? 'All checks passed' : `${String(failures)} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
