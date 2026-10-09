# Demo script (5 minutes, screen share)

The story: application teams should not need MQTT topics, device certificates, or SiteWise property IDs. The platform owns ingestion, modeling, and rollups, and exposes a typed API over the asset hierarchy.

## Before the call (about 15 minutes ahead)

```bash
export AWS_PROFILE=etp
# Edge host, if it was destroyed after the last demo (about 5 minutes to HEALTHY):
pnpm -F @etp/infra exec cdk deploy EtpEdgeHost --exclusively --profile etp \
  -c edgeHost=ec2 -c simulatorImageTag=<tag> -c alertEmail=<address>
pnpm edge:status                 # core HEALTHY, component RUNNING
pnpm check:ingest                # every property fresh
pnpm monitor:on                  # only once data is flowing, or the stale alarms fire
pnpm smoke                       # warms the Lambdas; needs 10+ minutes of data for aggregates
```

Have these tabs open, all in `ap-south-1`:

1. The README architecture diagram on GitHub.
2. A terminal with `AWS_PROFILE=etp`, `API` and `KEY` set (README "Query API" section).
3. A second terminal with an SSM session on the core: `aws ssm start-session --target <instance-id>`, then `sudo tail -f /greengrass/v2/logs/com.hashirakb.etp.SensorSimulator.log`.
4. IoT Greengrass console, core device `etp-edge-core-01`.
5. IoT SiteWise console, Assets, `kochi-01` expanded.
6. CloudWatch dashboard `etp-overview`.

Start the outage test **about 5 minutes before the call**: it takes 2 minutes of outage plus up to 2 minutes of replay, which is too long to sit through live. Keep its output on screen for step 6.

```bash
pnpm edge:outage-test 2>&1 | tee /tmp/outage.txt
```

## The 5 minutes

| Time | Show                                    | Say                                                                                                                                                                                                                                                                               |
| ---- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | README diagram                          | "Three planes: an edge that buffers, an ingest and model plane, and a query API. One topology file drives all of them. Sensors are simulated; everything else is real AWS."                                                                                                       |
| 0:40 | Greengrass console, then the device log | "A Greengrass v2 core on a t2.micro, provisioned with no inbound ports. The simulator is a Docker component. It has no certificate or AWS credentials; it publishes over IPC, and the nucleus owns the one MQTT connection and the disk spool." Point at `seq` in the log.        |
| 1:20 | SiteWise console: site, line, pump-01   | "Four models, eight assets, all generated from the topology. Measurements arrive by property alias, so devices never know SiteWise IDs. `temperature_f` is a transform, `max_vibration_5m` is a windowed metric, and the line rolls up its pumps and compressors."                |
| 2:00 | Terminal: API calls                     | Run `tree`, then `by-key/kochi-01/line-a/pump-01`, then `latest`. "This is what an application team sees: plant keys, typed JSON, a `stale` flag. The contract is generated from the same zod schemas the handlers validate with, and published as OpenAPI."                      |
| 2:50 | Terminal: fault injection               | `pnpm edge:fault bearingWear pump-02 600`. "This is a deployment config merge, not a new image. The component picks it up over IPC in about 20 seconds." Come back at 4:30 to show `vibration_alert` and status FAULT in `latest` for pump-02.                                    |
| 3:20 | Outage test output                      | "I cut outbound MQTT for 2 minutes. The nucleus noticed after about 50 seconds, spooled to disk, and replayed on reconnect. SiteWise has 36 of 36 points with no gap over 5 seconds, all at device time. A second run restarts Greengrass mid-outage, and the spool survives it." |
| 4:10 | CloudWatch `etp-overview`               | "Ingest rate per rule, rule failures, freshness per machine against the 120 second line, API p50, p95, p99. Stopping the edge pages by email in about five and a half minutes; I tested that end to end and it caught a real SNS policy bug."                                     |
| 4:30 | Terminal: `latest` for pump-02          | Show the fault arriving. Then `pnpm edge:fault clear`.                                                                                                                                                                                                                            |
| 4:45 | Close                                   | "Everything is CDK with CI on GitHub Actions, about 5 cents an hour while the edge runs, and `pnpm teardown` removes it. ADRs record where the AWS docs and I disagreed, and why."                                                                                                |

## If something goes wrong live

| Problem                             | Recovery                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| API calls time out or return 5xx    | Run the same calls with `pnpm smoke`; show the dashboard's Lambda errors widget and talk through it         |
| Fault does not show within a minute | Check the Greengrass console (Deployments, `etp-edge-cores`) and the device log for "configuration applied" |
| Device log quiet                    | `docker ps` on the core; `pnpm edge:status` falls back to SSM when the cloud lists no components            |
| Console tabs logged out             | Use the screenshots in [`docs/images/`](images/) and the outage output saved earlier                        |

## Afterwards

```bash
pnpm monitor:off
pnpm -F @etp/infra exec cdk destroy EtpEdgeHost --force --profile etp \
  -c edgeHost=ec2 -c simulatorImageTag=<tag> -c alertEmail=<address>
pnpm edge:deprovision
```

The rest of the platform costs about USD 1.60 a month idle and can stay deployed.
