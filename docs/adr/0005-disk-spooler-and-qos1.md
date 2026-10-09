# ADR 0005: Offline buffering with the Greengrass disk spooler and QoS 1

- Status: Accepted
- Date: 2026-10-10

## Context

Plant networks drop out. Telemetry produced while the edge cannot reach AWS IoT Core must not be lost, and must land at the time it was measured (ADR 0004). The edge must also survive the Greengrass core restarting during an outage.

## Decision

- The simulator publishes every message with **QoS 1** through Greengrass IPC (`PublishToIoTCore`). The nucleus owns the MQTT connection; the component never sees the network.
- The nucleus MQTT spooler uses **disk** storage through `aws.greengrass.DiskSpooler` (`mqtt.spooler.storageType: Disk`), sized at **10 MB**. At about 400 bytes per message and one message per second that is roughly 7 hours of traffic, well beyond the 30 minutes FR-EDGE-5 asks for.
- `keepQos0WhenOffline` stays `false`: every telemetry message is QoS 1, so nothing relies on QoS 0 being kept.
- Versions are pinned in the deployment (nucleus 2.18.3, DiskSpooler 1.0.9) so a redeploy never pulls an unexpected nucleus update.

## How it behaves

| Situation                         | What happens                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Network down                      | Publishes are accepted by the nucleus and written to the disk spool; the simulator keeps sampling normally |
| Network back                      | The nucleus reconnects and sends spooled messages; SiteWise stores each with its original device timestamp |
| Nucleus restart during the outage | The spool is on disk, so queued messages survive and are sent after restart                                |
| Spool full                        | New messages are **rejected** (Greengrass nucleus docs), not old ones dropped; sizing therefore matters    |
| Duplicate delivery (QoS 1 retry)  | SiteWise overwrites a value with the same timestamp and quality, so replays are idempotent                 |

The simulator's own in-memory buffer (FR-SIM-7) is a separate, inner layer: it only covers local IPC failures such as the nucleus being briefly unavailable.

## Verification

`pnpm edge:outage-test` drops outbound traffic to port 8883 on the core for 2 minutes, then checks SiteWise history for pump-01 for gaps longer than two publish intervals and for one point per interval. `--restart` also restarts Greengrass mid-outage. Results are recorded in `docs/INTERVIEW_NOTES.md` (Phase 6).

## Consequences

- Outage length is bounded by the spool size and by SiteWise's 7 day past-timestamp limit, whichever comes first.
- At fleet scale, high-volume sites would batch on the edge (Stream Manager) rather than spool individual MQTT messages (stretch goal S3).
