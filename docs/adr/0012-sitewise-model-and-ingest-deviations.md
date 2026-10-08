# ADR 0012: SiteWise model and ingest details that differ from the SRS

- Status: Accepted
- Date: 2026-10-09

## Context

SRS 0.3 says to follow current AWS docs over the SRS and record the differences. Phase 4 checked the SiteWise formula, metric, and IAM docs before writing CDK, then deployed and ran real traffic. Both steps found differences.

## Decisions

### 1. Line rollups read 5 minute child metrics, so pumps get `avg_temperature_5m`

The SRS defines `line_avg_pump_temperature_5m` as an average of each pump's `avg_temperature_1m`. The SiteWise metric docs say: "If you define any metric input variables in a metric's expression, those inputs must have the same time interval as the output metric." A 5 minute metric cannot read a 1 minute metric. Pumps therefore also get `avg_temperature_5m`, and the line rollup averages that. `validateModels()` in `shared` enforces this rule in a unit test, so a future model change fails in CI instead of at deploy time.

### 2. `line_max_vibration_5m` covers compressors too

The SRS rolls up pump vibration only. A site-level "max vibration" that ignores compressors would hide the machine most likely to vibrate, so compressors also get `max_vibration_5m`, and the line metric is `max(pumps, compressors)`.

### 3. `vibration_alert = gt(vibration, 7.1)`

`gt()` already returns 1 or 0, so the SRS's `if(gt(...), 1, 0)` wrapper is dropped. The output is identical.

### 4. `alert_minutes_5m = avg(vibration_alert) * 5`

`sum(vibration_alert)` counts alert _samples_, not minutes: at a 5 second interval that would report 60 for a fully alerting 5 minute window. The fraction of samples in alert, times 5, is minutes in alert as long as samples are evenly spaced, which they are.

### 5. The rule role is scoped to asset ARNs, not `Resource: "*"`

The AWS IoT SiteWise rule action docs show `Resource: "*"` with an `iotsitewise:assetHierarchyPath` condition. Deployed that way, every write by property alias failed with `AccessDeniedException`. Tested live against real traffic:

| Policy                                                         | Result                                     |
| -------------------------------------------------------------- | ------------------------------------------ |
| `Resource: "*"`, `assetHierarchyPath` condition (docs example) | Denied                                     |
| `time-series/*`, `propertyAlias` condition                     | Denied                                     |
| `time-series/*`, no condition                                  | Denied ("no identity-based policy allows") |
| `asset/*` and `time-series/*`, no condition                    | Allowed                                    |
| **`asset/*`, `assetHierarchyPath` condition**                  | **Allowed** (chosen)                       |

For aliases that belong to asset properties, SiteWise authorizes each entry against the **asset**. The chosen policy allows one action on this account's and region's asset ARNs, and only beneath the site's root asset. The SiteWise user guide's note to "authorize the time-series resource if you use a property alias" applies to data streams that are not associated with an asset property, which this platform does not use.

### 6. SiteWise accepts timestamps at most 5 minutes in the future

See ADR 0004: the SiteWise API reference says 10 minutes, the IoT rule action page says 5. Data arrives through the rule action, so the stricter 5 minutes applies.

### 7. Assets are addressable by external ID

Each asset has an external ID built from topology IDs joined by dots (`kochi-01.line-a.pump-01`). Topology IDs cannot contain dots, so this is unambiguous. SiteWise APIs that accept `externalId:<id>` let the Phase 5 API resolve `/assets/by-key/...` with one call instead of scanning.

### 8. Cross-stack references are explicitly strong

`EtpIngest` imports the root asset ID from `EtpSiteWise` through a CloudFormation export. CDK now asks for this to be chosen explicitly; `strong` is set in `cdk.json`, so CloudFormation refuses to delete or replace the root asset while the rule role still references it.

## Consequences

- The SRS names are kept for every property it defines; additions are `avg_temperature_5m` (pump) and `max_vibration_5m` (compressor).
- The IAM finding is the most useful interview story from this phase: the documented example did not work, and the fix came from testing each candidate against live traffic and reading the denial messages, not from guessing.
