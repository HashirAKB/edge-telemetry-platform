# ADR 0001: One topology config drives every layer

- Status: Accepted
- Date: 2026-10-07

## Context

The same plant structure (site, lines, machines) shows up in four places: SiteWise assets and their property aliases, IoT rule routing, the simulator's device list, and the API's topology keys. If each layer kept its own copy, adding a machine would mean editing several packages, and a typo in one of them would silently break ingestion (a value sent to an alias that no property owns is rejected).

## Decision

`packages/shared/src/topology.ts` is the only place the plant is described. Everything else is derived from it with shared helpers:

| Derived value                           | Helper                                          |
| --------------------------------------- | ----------------------------------------------- |
| MQTT topic per machine                  | `topicFor()`                                    |
| IoT rule SQL per machine type           | `ruleSqlForType()`                              |
| SiteWise property alias per measurement | `aliasFor()`, `aliasesForMachine()`             |
| Alias template inside the IoT rule      | `ruleAliasTemplate()`                           |
| Measurements and units per machine type | `NUMERIC_MEASUREMENTS`, `measurementNamesFor()` |
| API topology key                        | `externalKeyFor()`                              |

The topology is validated with zod when the module loads: IDs must match `^[a-z0-9]+(?:-[a-z0-9]+)*$` (SRS 4.1 allows `[a-z0-9-]`; leading, trailing, and doubled hyphens are also rejected so aliases stay unambiguous), machine IDs must be unique across the whole site, and every machine type must be known. A bad edit fails every build, test, and `cdk synth` immediately instead of failing at deploy time.

A unit test substitutes real topics into the IoT rule's alias template and checks the result equals `aliasFor()` for every measurement of every machine. That is the contract between the edge, the rule, and SiteWise, and it is enforced without deploying anything.

## Consequences

- Adding a machine is a one-line change to `topology.ts` (FR-SW-3); infra and simulator pick it up on the next deploy.
- Machine IDs are globally unique within a site, which is stricter than aliases need (aliases include the line ID) but lets logs, the payload `machineId`, and the simulator identify a machine by ID alone.
- At larger scale (many sites, frequent changes), the topology would move from code to a registry (for example a DynamoDB table or the SiteWise hierarchy itself) with the same validation, so plant changes no longer require a code deploy.
