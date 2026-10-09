# Runbook

Operational steps for the deployed platform. Every command takes an explicit AWS profile; nothing relies on default credentials. Replace `etp` with your profile name. The region is pinned to `ap-south-1` in the CDK app (override with `-c region=...`).

## Edge (Greengrass on EC2)

### Bring the edge up

```bash
export AWS_PROFILE=etp

# 1. Build and push the simulator image (tagged with the git short SHA; tags are immutable).
pnpm edge:publish-image                       # prints the tag, e.g. 0954bb1

# 2. Cloud side: thing group, roles, component, deployment.
pnpm -F @etp/infra exec cdk deploy EtpEdge --exclusively --profile etp -c simulatorImageTag=<tag>

# 3. The EC2 core host (t2.micro, no inbound ports, SSM access).
pnpm -F @etp/infra exec cdk deploy EtpEdgeHost --exclusively --profile etp \
  -c edgeHost=ec2 -c simulatorImageTag=<tag>

# 4. Wait 3 to 5 minutes, then check: core HEALTHY and component RUNNING.
pnpm edge:status
```

Pass the CDK `-c` options literally on the command line. Putting them in a shell variable (`$OPTS`) does not word-split in zsh, and the image tag silently goes missing; the app now refuses to synthesize with credentials but without a tag.

### Look at the device

```bash
aws ssm start-session --target <instance-id>      # interactive shell, no SSH or open ports
sudo tail -f /greengrass/v2/logs/com.hashirakb.etp.SensorSimulator.log
sudo tail -f /greengrass/v2/logs/greengrass.log
docker ps
```

The instance ID is the `EtpEdgeHost.InstanceId` stack output.

### Demos

```bash
pnpm edge:outage-test              # SRS 13.3: 2 min without MQTT, then zero-loss check
pnpm edge:outage-test --restart    # same, with a Greengrass restart during the outage
pnpm edge:fault bearingWear pump-02 600   # SRS 13.2: live fault via deployment config merge
pnpm edge:fault clear
```

The outage test blocks only outbound TCP 8883 (MQTT) with iptables and restores it on exit, so SSM keeps working throughout.

### Troubleshooting

| Symptom                                          | Check                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Core never appears in `edge:status`              | `/var/log/cloud-init-output.log` on the instance: provisioning or installer errors    |
| Core HEALTHY but no data                         | Component log above; `docker ps`; IoT rule errors in `/etp/iot/rule-errors`           |
| Data marked stale by the API                     | Device clock: `chronyc tracking` (values carry device timestamps, ADR 0004)           |
| Instance fails to launch with a vCPU limit error | The account allows 1 vCPU: destroy the old host before deploying a new one (ADR 0014) |
| Insufficient capacity in an availability zone    | Deploy with `-c edgeAz=ap-south-1c` (or another zone)                                 |

### Tear the edge down (in this order)

```bash
pnpm -F @etp/infra exec cdk destroy EtpEdgeHost --profile etp -c edgeHost=ec2 -c simulatorImageTag=<tag>
pnpm edge:deprovision                 # thing, certificate, and core device created on the instance
pnpm -F @etp/infra exec cdk destroy EtpEdge --profile etp -c simulatorImageTag=<tag>
```

`edge:deprovision` is needed because the instance creates its own AWS IoT thing and certificate during installation (ADR 0014); CloudFormation does not manage them.

## Monitoring

```bash
pnpm monitor:on     # start the freshness monitor (every minute) before a demo
pnpm monitor:off    # stop it afterwards so stale alarms do not page during intentional downtime
```

- Dashboard: CloudWatch, `etp-overview` (ingest rate, rule failures, freshness per machine, API latency, Lambda errors).
- Alarms go to the `etp-alerts` SNS topic. The email subscription comes from CDK context: deploy `EtpObservability` with `-c alertEmail=<address>` and click the confirmation link AWS sends; nothing is delivered until then.
- Expected timing: a machine is marked stale after 120 seconds without a value for 3 consecutive minutes, so the stale and "simulator offline" emails arrive about 5.5 minutes after the edge stops (measured: 5 min 24 s and 5 min 32 s).
- Deploying `EtpObservability` on its own the first time fails with "No export named EtpFoundation:...AlertsTopic": deploy `EtpFoundation EtpObservability` together (without `--exclusively`) so the export exists.
