# Architecture

The platform has three planes. The **edge** produces telemetry and keeps it safe through outages. The **ingest and model** plane turns MQTT messages into an asset hierarchy with derived values. The **query** plane gives application teams a typed API over that hierarchy. One topology file in `packages/shared` drives all three (ADR 0001).

```mermaid
flowchart LR
  subgraph Edge["Edge: Greengrass v2 core on EC2 t2.micro (EtpEdgeHost)"]
    SIM["SensorSimulator component<br/>Docker container, TypeScript"]
    NUC["Greengrass nucleus 2.18<br/>IPC server, MQTT client"]
    SPOOL["DiskSpooler<br/>10 MB on disk"]
    SIM -- "IPC PublishToIoTCore, QoS 1" --> NUC
    NUC <--> SPOOL
  end

  subgraph Cloud["AWS ap-south-1"]
    CORE["AWS IoT Core<br/>MQTT broker"]
    RULES["Topic rules, one per machine type<br/>(EtpIngest)"]
    ERR["Error action<br/>/etp/iot/rule-errors"]
    SW["AWS IoT SiteWise<br/>4 models, 8 assets,<br/>transforms, metrics, rollups<br/>(EtpSiteWise)"]
    APIGW["API Gateway REST<br/>API key, usage plan (EtpApi)"]
    CAT["asset-catalog Lambda"]
    TQ["telemetry-query Lambda"]
    FR["freshness-monitor Lambda<br/>every minute (EtpObservability)"]
    CW["CloudWatch dashboard and alarms"]
    SNS["SNS etp-alerts, email"]
    ECR["ECR etp/simulator<br/>(EtpFoundation)"]
  end

  NUC -- "MQTT over TLS 8883" --> CORE --> RULES
  RULES -- "BatchPutAssetPropertyValue<br/>by property alias, device timestamp" --> SW
  RULES -. "on failure" .-> ERR
  ECR -. "image pull with TES credentials" .-> SIM
  APP["Application teams, curl, Grafana"] --> APIGW
  APIGW --> CAT --> SW
  APIGW --> TQ --> SW
  FR --> SW
  FR --> CW --> SNS
```

## Stacks

| Stack              | Contents                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `EtpFoundation`    | ECR repository for the simulator image, SNS alerts topic, rule error log group                               |
| `EtpSiteWise`      | Asset models (site, line, pump, compressor) and the 8 assets, generated from the topology                    |
| `EtpIngest`        | One IoT topic rule per machine type, the rule role (alias-scoped), the error action                          |
| `EtpApi`           | REST API built from the shared route table, two Lambda services, API key and usage plan                      |
| `EtpObservability` | Freshness monitor and its schedule, 12 alarms, the `etp-overview` dashboard, the monthly budget              |
| `EtpEdge`          | Thing group, core IoT policy, token exchange role and alias, the simulator component, the deployment         |
| `EtpEdgeHost`      | VPC without NAT, a security group with no inbound rules, the t2.micro core host; only with `-c edgeHost=ec2` |

## Names derived from the topology

A machine `pump-01` on `line-a` at `kochi-01` gets every name from small functions in `packages/shared`:

| Use               | Value                                                | Built by                 |
| ----------------- | ---------------------------------------------------- | ------------------------ |
| MQTT topic        | `telemetry/v1/kochi-01/line-a/pump/pump-01`          | `topicFor()`             |
| Rule topic filter | `telemetry/v1/+/+/pump/+`                            | `topicFilterForType()`   |
| Property alias    | `/kochi-01/line-a/pump-01/temperature_c`             | `aliasFor()`             |
| Alias in the rule | `/${topic(3)}/${topic(4)}/${topic(6)}/temperature_c` | `ruleAliasTemplate()`    |
| Asset external ID | `kochi-01.line-a.pump-01`                            | `assetExternalIdFor()`   |
| API key lookup    | `GET /v1/assets/by-key/kochi-01/line-a/pump-01`      | route table `API_ROUTES` |

A unit test proves that the rule template and `aliasFor()` produce the same string for every measurement of every machine, so the cloud and the device agree without a deploy.

## Ingest: one sample from sensor to SiteWise

Every 5 seconds each simulated machine produces one message with 4 numeric measurements and a status, timestamped on the device.

```mermaid
sequenceDiagram
  autonumber
  participant SIM as Simulator (container)
  participant NUC as Greengrass nucleus
  participant SP as DiskSpooler
  participant IOT as IoT Core
  participant R as Rule etp_telemetry_v1_pump
  participant SW as SiteWise
  participant L as /etp/iot/rule-errors

  SIM->>SIM: sample signals, validate TelemetryMessageV1 (zod), seq += 1
  SIM->>NUC: IPC PublishToIoTCore(telemetry/v1/kochi-01/line-a/pump/pump-01, QoS 1)
  NUC->>SP: persist message
  NUC->>IOT: MQTT PUBLISH over TLS (client ID = thing name)
  IOT-->>NUC: PUBACK
  NUC->>SP: remove message
  IOT->>R: SELECT * FROM 'telemetry/v1/+/+/pump/+'
  R->>SW: BatchPutAssetPropertyValue: 5 entries,<br/>alias /${topic(3)}/${topic(4)}/${topic(6)}/<measurement>,<br/>time floor(ts / 1E3) s + (ts % 1E3) * 1E6 ns
  SW->>SW: resolve alias, store measurements
  SW->>SW: transforms per point (temperature_f, vibration_alert)
  SW->>SW: metrics per window (1m, 5m), line rollups over child pumps and compressors
  alt write rejected (IAM, bad alias, timestamp out of range)
    R->>L: error action: payload and failure reason
  end
```

Notes:

- The container has no certificate and no AWS credentials. The nucleus authenticates it over IPC with `SVCUID`, and the recipe's access control allows only `PublishToIoTCore` on `telemetry/v1/#` (ADR 0006).
- The rule role may write only to data streams whose alias starts with `/kochi-01/` and to the 5 machine assets by ARN (ADR 0012).
- A QoS 1 duplicate writes the same timestamp and value again, which SiteWise treats as the same point.

## Outage replay: zero loss across a network drop and a restart

`pnpm edge:outage-test` blocks outbound TCP 8883 on the core host for 2 minutes with iptables (SSM keeps working on 443) and then checks SiteWise history for gaps.

```mermaid
sequenceDiagram
  autonumber
  participant SIM as Simulator
  participant NUC as Nucleus
  participant SP as DiskSpooler
  participant IOT as IoT Core
  participant SW as SiteWise

  Note over NUC,IOT: T0: iptables drops outbound 8883
  loop every 5 s per machine
    SIM->>NUC: PublishToIoTCore (QoS 1)
    NUC->>SP: persist
    NUC--xIOT: PUBLISH not acknowledged
  end
  Note over NUC: about 50 s later the keepalive ping fails:<br/>"Connection interrupted"
  opt restart variant: systemctl restart greengrass during the outage
    Note over SIM,SP: simulator drains on SIGTERM (unsent 0),<br/>the spool survives on disk
  end
  Note over NUC,IOT: T0 + 2 min: rule removed
  NUC->>IOT: reconnect, "Connection resumed" (sessionPresent=true)
  loop drain the spool in order
    NUC->>IOT: PUBLISH spooled message (original device ts)
    IOT-->>NUC: PUBACK
    NUC->>SP: remove
  end
  IOT->>SW: rules write every point at its device timestamp
  Note over SW: history for T0 to T0 + 3 min: 36 of 36 points,<br/>largest gap 5 s (restart run: 6.1 s)
```

The outage window is bounded by two limits: SiteWise accepts timestamps up to 7 days old (ADR 0004), and the spool holds 10 MB. Messages are about 240 bytes, so at the default rate (3,600 messages an hour across 5 machines) the spool holds roughly 10 hours. The spool fills first, so the configured size, not SiteWise, is what limits the outage this build survives.

## Query: latest values through the API

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant G as API Gateway
  participant F as telemetry-query Lambda
  participant T as Catalog (tree cache, 5 min)
  participant SW as SiteWise

  C->>G: GET /v1/assets/{assetId}/latest, x-api-key
  G->>G: check the API key, apply the usage plan (10 rps, burst 20, 10,000 a day)
  G->>F: proxy event
  F->>F: validate params with the shared zod schema (400 problem+json on failure)
  F->>T: node(assetId)
  alt cache cold or expired
    T->>SW: DescribeAsset(externalId:kochi-01), then children per hierarchy
    T->>SW: DescribeAssetModel (once per model)
    T-->>T: index the site tree by asset ID and plant key
  end
  T-->>F: node with its properties, or 404 if outside this site
  F->>SW: BatchGetAssetPropertyValue (chunks of up to 128 entries)
  SW-->>F: latest value per property
  F->>F: shape the typed response, stale = newest measurement older than 3 x interval
  F-->>G: 200 application/json (Powertools logs, EMF metrics, X-Ray trace)
  G-->>C: response
```

Aggregates and history follow the same path with `GetAssetPropertyAggregates` and `GetAssetPropertyValueHistory`. The reader rounds query bounds to whole seconds, because SiteWise rejects dates with milliseconds. Measured p95 against live data: tree 59 ms (warm), latest 156 ms, aggregates over 24 hours at 1 minute 81 ms (`pnpm smoke`).

## Freshness monitoring

```mermaid
sequenceDiagram
  participant S as EventBridge Scheduler
  participant M as freshness-monitor Lambda
  participant SW as SiteWise
  participant CW as CloudWatch
  participant N as SNS etp-alerts

  S->>M: every minute (only while pnpm monitor:on)
  M->>SW: BatchGetAssetPropertyValue: temperature_c for 5 machines
  M->>CW: SecondsSinceLastValue per machineId (EMF)
  CW->>CW: etp-stale-<machine>: above 120 s for 3 of 3 minutes
  CW->>CW: etp-simulator-offline: every machine stale
  CW->>N: alarm notification
  N->>N: email to the address passed as CDK context
```

Measured end to end: with Greengrass stopped, the stale alarms fired 5 minutes 24 seconds later and the composite 8 seconds after that.

## Security boundaries

| Boundary             | Control                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device to IoT Core   | X.509 certificate; the core policy names its own thing: connect as that client ID, publish telemetry only under `telemetry/v1/`, plus its own Greengrass health, jobs, and shadow topics |
| Container to nucleus | IPC access control: `PublishToIoTCore` on `telemetry/v1/#` only                                                                                                                          |
| Device to AWS APIs   | Token exchange role via role alias: pull from the one ECR repository; no long-lived keys on the device                                                                                   |
| EC2 host             | No inbound rules, IMDSv2 only, SSM for shell access; instance role has 5 IoT actions and no IAM actions                                                                                  |
| Rule to SiteWise     | Write only to aliases under `/kochi-01/` and the 5 machine assets                                                                                                                        |
| API callers          | API key and usage plan; Lambda roles are read-only on SiteWise                                                                                                                           |
| Repository           | gitleaks scans the full history in CI; certificates live in `.certs/` (gitignored) or only on the device                                                                                 |
