# ADR 0004: Use device timestamps, not ingest time

- Status: Accepted
- Date: 2026-10-07

## Context

When the edge loses connectivity, Greengrass spools messages to disk and sends them after reconnecting. If SiteWise stamped values with ingest time, a 2 minute outage would show up as a gap followed by a burst of values all timestamped at the moment of reconnection, and windowed metrics would be wrong.

## Decision

Every message carries `ts`, the device's epoch milliseconds at sample time. The IoT rule converts it into the SiteWise timestamp: `timeInSeconds = floor(ts / 1000)` and `offsetInNanos = (ts % 1000) * 1000000`. Replayed data lands at the time it was measured.

The message schema rejects `ts` values before 2020-01-01. This catches the common bug of sending epoch seconds instead of milliseconds, which would otherwise be accepted as a date in January 1970 and then rejected by SiteWise far from the cause.

## Future bound: the AWS docs disagree

The SRS states that SiteWise accepts timestamps up to 7 days in the past and 5 minutes in the future. Two current AWS pages (checked 2026-10-07 and 2026-10-09) disagree on the future bound:

- The `BatchPutAssetPropertyValue` API reference: the inclusive range **[-7 days, +10 minutes]**.
- The AWS IoT SiteWise rule action page: "up to 7 days in the past up to **5 minutes** in the future."

Data in this platform reaches SiteWise through the rule action, so the code uses the stricter value: `SITEWISE_MAX_FUTURE_MS` is 5 minutes, which also matches the SRS. `isWithinSiteWiseWindow()` implements the inclusive range.

## Consequences

- **Maximum outage.** The edge can be offline for up to 7 days before buffered data is rejected. In practice the disk spooler size is the tighter limit, and it is sized in Phase 6 for at least 30 minutes of traffic (FR-EDGE-5).
- **Clock accuracy matters.** A device clock running more than 5 minutes fast has every value rejected. Greengrass core devices should run NTP (chrony on Amazon Linux), which the runbook will cover.
- **Replays are idempotent.** SiteWise overwrites a value with the same timestamp and quality, so a message delivered twice (possible with QoS 1) does not create a duplicate point.
