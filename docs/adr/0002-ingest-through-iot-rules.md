# ADR 0002: Ingest through AWS IoT Core rules with the SiteWise action

- Status: Accepted
- Date: 2026-10-09

## Context

Telemetry has to get from edge devices into SiteWise asset properties. Three common routes:

1. Devices call `BatchPutAssetPropertyValue` directly with the AWS SDK.
2. Devices publish MQTT to AWS IoT Core, and a topic rule writes into SiteWise.
3. Greengrass Stream Manager exports from the edge straight to SiteWise.

## Decision

Route 2. Devices publish plain JSON over MQTT to `telemetry/v1/{site}/{line}/{type}/{machine}`. One topic rule per machine type (`SELECT * FROM 'telemetry/v1/+/+/{type}/+'`) maps each measurement to a property alias built from topic segments and writes it with the device timestamp.

## Why

- **The edge stays simple.** Devices speak MQTT only. They need no AWS SDK credentials, no SiteWise IDs, and no knowledge of the asset model. A device certificate with a policy that allows publishing under `telemetry/v1/` is all they hold.
- **Mapping lives in the platform.** Changing how measurements map to properties is a cloud deploy, not a fleet update.
- **Failures are central and visible.** Every rule has an error action that writes the failed message and the reason to `/etp/iot/rule-errors`. Phase 4 relied on exactly this to diagnose an IAM problem within minutes (ADR 0012).
- **Fan-out is cheap.** The same message can also go to S3 (the optional raw archive, FR-ING-7) or anywhere else by adding a rule action, without touching devices.

## Alternatives

- **Direct SDK writes from devices** couple every device to SiteWise IDs or aliases and AWS credentials, and spread error handling across the fleet.
- **Stream Manager export** is a strong option for high volume or long offline periods, because it batches on the device and writes to SiteWise without IoT Core messaging costs. It ties the edge more closely to SiteWise and is harder to observe centrally. It is kept as stretch goal S3 with its own comparison.

## Consequences

- Each message costs one IoT Core message, one rule trigger, one rule action, and one SiteWise ingestion message per value (see `docs/cost.md`).
- Rules have no retry of their own; a failed SiteWise write is logged by the error action, not retried. For this build that is acceptable and visible; at scale, the error action would go to a queue for replay.
