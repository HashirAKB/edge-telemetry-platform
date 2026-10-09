# Traceability: resume claims to evidence

Each resume claim (SRS 1.2) is mapped to the requirements behind it and to evidence that can be checked: a test, a script that runs against the live deployment, or a measured result. Anything that is not fully true as worded is flagged under each claim, along with where the build differs from the SRS. Measurements are from the deployment in `ap-south-1` on 2026-10-09.

Legend: **Met** means true as worded. **Met, with a note** means true, with a detail an interviewer could probe.

## C1: Greengrass edge

> A Greengrass v2 core device runs a containerized (Docker) component that simulates industrial sensors and publishes telemetry over MQTT, with buffering for intermittent connectivity.

Status: **Met, with notes.**

| Part of the claim                       | Requirements         | Evidence                                                                                                                                                 |
| --------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Greengrass v2 core device               | FR-EDGE-1, FR-EDGE-6 | `pnpm edge:status`: core `etp-edge-core-01` HEALTHY, nucleus 2.18.3; Greengrass console                                                                  |
| Containerized (Docker) component        | FR-EDGE-2, FR-EDGE-3 | `com.hashirakb.etp.SensorSimulator` recipe in `EtpEdge`; image from ECR `etp/simulator`; `docker ps` on the device shows `etp-sensor-simulator`          |
| Simulates industrial sensors            | FR-SIM-1 to 4        | Simulator unit tests (signals, load, faults, status); fault injection: pump-02 reached FAULT, `max_vibration_5m` 10.86 (13.2)                            |
| Publishes telemetry over MQTT           | FR-SIM-5, FR-EDGE-3  | IPC `PublishToIoTCore` QoS 1 to the nucleus, MQTT over TLS to IoT Core; `pnpm check:ingest`: 61 of 61 properties fresh                                   |
| Buffering for intermittent connectivity | FR-SIM-7, FR-EDGE-5  | `pnpm edge:outage-test`: 2 minutes without MQTT, 36 of 36 points, largest gap 5 s; `--restart` variant 6.1 s (13.3); see [architecture](architecture.md) |
| Configuration changed live              | FR-SIM-6, FR-EDGE-4  | `pnpm edge:fault`: a deployment config merge applied over IPC in about 19 s, no image rebuild                                                            |

Notes:

- **Simulated sensors.** The sensors are simulated, and the resume wording already says so. Everything from the Greengrass core onwards is real AWS.
- **Host differs from the SRS.** The host is a `t2.micro`, not a `t3.small`, because the account's vCPU quota is 1. It uses manual rather than automatic provisioning, because the installer's automatic mode attaches a broad IAM policy (ADR 0014).
- **Component status is read over SSM.** The Greengrass cloud API (`ListInstalledComponents`) returns an empty list for this core, even though the device reports HEALTHY and the component runs. `pnpm edge:status` therefore confirms RUNNING through SSM on the device. This is an open item, not hidden.

Latest outage test run, 2026-10-09 (`pnpm edge:outage-test`):

```
blocked 2026-10-09T09:57:09Z
restored 2026-10-09T09:59:09Z

waiting for spooled messages to replay into SiteWise...
  6/36 points, max gap 5.004 s
  6/36 points, max gap 5.004 s
  37/36 points, max gap 5.004 s

PASS  largest gap 5.004 s (limit 10 s)
PASS  37 points for 36 intervals (window 2026-10-09T09:56:38.901Z to 2026-10-09T09:59:40.953Z)
component log drops/failures: none
```

## C2: Rules into SiteWise

> AWS IoT Core rules route measurements into AWS IoT SiteWise asset models, with transforms and windowed metrics (rollups) across an equipment hierarchy.

Status: **Met, with a note.**

| Part of the claim                               | Requirements            | Evidence                                                                                                                                           |
| ----------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| IoT Core rules route measurements               | FR-ING-1 to 4, FR-ING-6 | `EtpIngest`, one rule per machine type; infra assertion tests on SQL, aliases, and timestamps; error action to `/etp/iot/rule-errors`              |
| Into SiteWise asset models                      | FR-SW-1, FR-SW-2        | `EtpSiteWise`: 4 models, 8 assets generated from the topology; `GET /v1/assets/tree` returns 1 site, 2 lines, 5 machines                           |
| Transforms                                      | 4.3                     | `temperature_f` checked against `temperature_c` at every shared timestamp by `pnpm smoke` (0 mismatches); `vibration_alert` went to 1 in 13.2      |
| Windowed metrics and rollups across a hierarchy | 4.3, FR-SW-3            | `pnpm smoke`: line-a max vibration equals the max of its machines in the same window; 1 m aggregates; adding a machine is covered by an infra test |
| Device timestamps                               | FR-ING-3                | Outage replay lands every point at its original time; unit test on the timestamp templates                                                         |

Note:

- **Rule permissions differ from the SRS.** FR-ING-5 asked for the `assetHierarchyPath` condition. Tested against live traffic, SiteWise never supplies that key for alias writes, so the docs' example policy always fails. The role is scoped by `iotsitewise:propertyAlias` (`/kochi-01/*`) and by explicit machine asset ARNs instead (ADR 0012). It is still least privilege, just on a different condition key.

## C3: Typed query API

> TypeScript Lambda microservices behind API Gateway expose a typed telemetry query API (latest values, aggregates, asset tree), so application teams consume telemetry without touching IoT plumbing.

Status: **Met.**

| Part of the claim                   | Requirements        | Evidence                                                                                                                              |
| ----------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript Lambda microservices     | FR-API-11, ADR 0007 | `asset-catalog` and `telemetry-query` (Node.js 24, ARM64), each with its own read-only role and alarms                                |
| Behind API Gateway                  | FR-API-9, FR-API-10 | REST API `etp-query-api`, API key and usage plan; `pnpm smoke`: 403 without a key, health open                                        |
| Typed API: latest, aggregates, tree | FR-API-1 to 8       | Shared zod schemas validate requests and generate [`openapi.yaml`](openapi.yaml) (CI fails on drift); API unit tests; 16 smoke checks |
| Without touching IoT plumbing       | SRS 1.3             | Clients use plant keys (`by-key/kochi-01/line-a/pump-01`); no topic, certificate, or SiteWise ID appears in the API contract          |
| Performance                         | NFR-1               | p95 tree 59 ms (warm), latest 156 ms, aggregates over 24 h at 1 m 81 ms, against targets of 500 ms and 1.5 s                          |

## C4: CDK and CI

> All infrastructure is defined in AWS CDK, with CI via GitHub Actions.

Status: **Met, with notes.**

| Part of the claim         | Evidence                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Infrastructure in AWS CDK | 7 stacks in `packages/infra`; 49 assertion tests, including no wildcard IAM actions and nothing retained on delete                                                              |
| CI via GitHub Actions     | [`ci.yml`](../.github/workflows/ci.yml): lint, format, typecheck, build, tests with coverage thresholds, OpenAPI drift check, `cdk synth`, image build and size limit, gitleaks |

Note:

- **A few things sit outside CloudFormation, all scripted and documented.** The Greengrass installer creates the core's thing and certificate on the instance (`pnpm edge:deprovision` removes them). The CDK bootstrap stack is shared. A zero-spend budget was created by hand. "All infrastructure" is accurate for everything the platform runs on.
- **Not tested end to end.** The full `pnpm teardown` has run only as `--dry-run`, because the platform is kept deployed for interviews. Destroying `EtpEdgeHost` has been done for real several times.

## C5: Stack

> Stack: TypeScript, AWS CDK, AWS IoT Greengrass v2, AWS IoT Core, AWS IoT SiteWise, AWS Lambda, API Gateway, Docker.

Status: **Met.** Every item is used in the deployed system. See the [README tech stack](../README.md#tech-stack).

## Other targets and how they measured

| Target                                                       | Result                                                                                                             | Status             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------ |
| NFR-2: sample to SiteWise latest value under 10 s            | Latest value is 0.5 s old at best and never more than the 5 s publish interval                                     | Met                |
| NFR-3: zero loss across a 2 minute outage and a core restart | 36 of 36 points; restart variant also complete                                                                     | Met                |
| NFR-5: under USD 10 a month while running                    | About 5 cents an hour per demo session; 24/7 would be about USD 24 telemetry plus USD 14 host                      | Met on demand only |
| NFR-6: 80 percent coverage on shared, simulator, api         | Enforced in CI (shared 90 percent)                                                                                 | Met                |
| Phase 7: stale alarm email within 5 minutes                  | 5 min 24 s. FR-OBS-3's own rule (over 120 s for 3 of 3 one-minute periods) cannot fire sooner than about 5 minutes | Close, flagged     |
| SRS 2.2 stretch goals S1 to S5                               | Not built; S1 is recorded as ADR 0009                                                                              | Not started        |

## Suggested resume wording

The claims hold as written. Two optional changes would make them harder to challenge:

- C1: "...simulates industrial sensors and publishes telemetry over MQTT, with **disk-backed** buffering **verified across a 2-minute outage and a core restart**."
- C2: if asked about the IAM policy, the honest answer is that the documented example did not work and why (ADR 0012). This is a strength to bring up, not something to hide.
