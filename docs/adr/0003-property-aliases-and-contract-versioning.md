# ADR 0003: Address SiteWise properties by alias; version the contract in the topic

- Status: Accepted
- Date: 2026-10-07

## Context

SiteWise identifies a property by `assetId` plus `propertyId` (UUIDs created at deploy time) or by a `propertyAlias` string. Edge devices should not need to know cloud-generated IDs, and the edge-to-cloud contract will eventually need to change without breaking devices already in the field.

## Decision

**Aliases.** Every measurement property gets the alias `/{siteId}/{lineId}/{machineId}/{measurement}`, for example `/kochi-01/line-a/pump-01/temperature_c`. The IoT rule builds the same string from topic segments (`/${topic(3)}/${topic(4)}/${topic(6)}/temperature_c`), so neither the device nor the rule needs a SiteWise ID. The rule writes with `BatchPutAssetPropertyValue`, which accepts `propertyAlias` directly.

**Versioning.** The contract version appears twice: in the topic (`telemetry/v1/...`) and in the payload (`"v": 1`). Rules subscribe to `telemetry/v1/+/+/{type}/+`, so a future `v2` contract gets its own topic tree and its own rules, and both run side by side while devices migrate. The payload `v` field guards against a message published to the wrong tree. Payloads are validated with strict schemas: unknown fields and unexpected metrics are errors, not silently dropped, so contract drift is caught on the device before publish.

## Alternatives considered

- **Asset and property IDs on the device.** Couples every device to one deployment's UUIDs; redeploying SiteWise would mean reconfiguring the fleet.
- **Version only in the payload.** One rule would have to branch on `v` for every machine type, and a breaking change could not be rolled out gradually.

## Consequences

- Aliases are human-readable, which makes rule errors and SiteWise queries easy to debug.
- Renaming a site, line, or machine ID changes its aliases, so IDs are treated as permanent keys and display names live in the separate `name` field.
- Data sent to an alias that no property owns is rejected by SiteWise and lands in the rule error log, which the observability phase alarms on.
