# Cost

Prices are AWS list prices for Asia Pacific (Mumbai, `ap-south-1`), pulled from the AWS Price List API on 2026-10-09. They change; re-check before relying on them.

## Unit prices

| Service          | Dimension                                         | Price                                 |
| ---------------- | ------------------------------------------------- | ------------------------------------- |
| AWS IoT Core     | Messages (first 1 billion per month)              | $1.05 per million                     |
| AWS IoT Core     | Rules triggered                                   | $0.158 per million                    |
| AWS IoT Core     | Rule actions executed                             | $0.158 per million                    |
| AWS IoT Core     | Connectivity                                      | $0.092 per million connection-minutes |
| AWS IoT SiteWise | Data ingestion (messaging)                        | $1.30 per million messages            |
| AWS IoT SiteWise | Data processing (transforms, metrics, aggregates) | $0.65 per million computations        |
| AWS IoT SiteWise | Hot tier storage                                  | $0.013 per GB-day                     |

AWS IoT Core has a 12-month free tier for new accounts (500,000 messages, 250,000 rules triggered, and 250,000 actions per month). SiteWise has no free tier. Asset models and assets have no standing charge.

## What one device message costs

Each simulator message carries 5 values (4 numeric measurements and `status`). SiteWise meters each property entry as its own ingestion message.

| Item                                            | Per device message | Cost per million device messages |
| ----------------------------------------------- | ------------------ | -------------------------------- |
| IoT Core message                                | 1                  | $1.05                            |
| Rule triggered and SiteWise action              | 1 + 1              | $0.32                            |
| SiteWise ingestion                              | 5                  | $6.50                            |
| Transforms (`temperature_f`, `vibration_alert`) | 2 computations     | $1.30                            |
| **Total**                                       |                    | **about $9.17**                  |

Metrics add a few computations per machine per window (negligible next to the above). SiteWise also computes automatic aggregates for every property; those are billed as computations too and are not modeled here, so treat the totals below as a floor and check Cost Explorer after a run.

## Running cost at the default rate

5 machines x 1 message every 5 seconds = 1 device message per second.

| Running pattern                          | Device messages | Approximate cost |
| ---------------------------------------- | --------------- | ---------------- |
| One hour                                 | 3,600           | $0.03            |
| One 10 minute test (Phase 4)             | 600             | under $0.01      |
| 24 hours                                 | 86,400          | $0.80            |
| 24/7 for a month                         | 2.6 million     | **$24 or more**  |
| 24/7 for a month at a 30 second interval | 0.43 million    | about $4         |

**The platform is meant to run on demand.** NFR-5 asks for under $10 per month while running; at the default 5 second interval that holds for demo sessions (about 3 cents an hour), not for 24/7 operation. Run it for demos and stop the publisher afterwards, or deploy the edge with a 30 second interval if it must stay on.

## Idle cost

With nothing publishing, the deployed stacks cost close to nothing:

| Resource                                | Idle cost                                                 |
| --------------------------------------- | --------------------------------------------------------- |
| SiteWise asset models and assets        | none                                                      |
| IoT topic rules, IAM roles, SNS topic   | none                                                      |
| ECR repository (empty until Phase 6)    | storage only, cents per month                             |
| CloudWatch log group (14 day retention) | storage only, cents per month                             |
| SiteWise stored data                    | $0.013 per GB-day; a 10 minute run stores well under 1 MB |
| CDK bootstrap bucket and repository     | storage only, cents per month                             |

## Monitoring cost

Mumbai list prices (2026-10-10): custom metrics USD 0.30 per metric-month (billed by the hour, only while data arrives), standard alarms USD 0.10 per alarm-month, composite alarms USD 0.50 per month, the first three dashboards free.

| Item                                                                     | Always deployed              | Cost per month                      |
| ------------------------------------------------------------------------ | ---------------------------- | ----------------------------------- |
| 11 metric alarms and 1 composite alarm                                   | yes                          | about USD 1.60                      |
| `etp-overview` dashboard                                                 | yes                          | free (within three dashboards)      |
| `etp-monthly` budget                                                     | yes                          | free (first two budgets)            |
| Freshness monitor (5 custom metrics, 43,200 Lambda runs, SiteWise reads) | only while `pnpm monitor:on` | about USD 1.80 if left on all month |

The freshness schedule is **off by default**. An always-on monitor on an on-demand platform would send "stale" emails every time the edge is intentionally stopped. Turn it on for demos (`pnpm monitor:on`) and off afterwards (`pnpm monitor:off`); with no data, the alarms treat missing data as healthy and stay quiet.

## Guardrails

- `etp-monthly`: a USD 10 monthly AWS Budgets budget in CDK (FR-OBS-5) that emails at 50, 80, and 100 percent of actual spend and 100 percent of forecast.
- An AWS zero-spend budget, set up by hand in the console earlier. It emails on the first cent of spend.
- `pnpm teardown` (Phase 8) removes every billable resource (NFR-8).
