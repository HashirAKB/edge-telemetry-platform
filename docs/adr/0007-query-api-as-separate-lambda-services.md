# ADR 0007: Query API as two Lambda services behind one REST API

- Status: Accepted
- Date: 2026-10-10

## Context

Application teams need a stable, typed way to read telemetry without learning SiteWise, MQTT topics, or property IDs (SRS 1.3). The API has two kinds of work: describing the plant (asset tree, lookups) and reading time series (latest values, history, aggregates).

## Decision

- **Two Lambda functions, one API.** `asset-catalog` serves the tree, asset details, key lookups, and health. `telemetry-query` serves latest values, history, and aggregates. API Gateway routes each path to its function; the route table lives in `packages/shared` and drives both the infrastructure and the OpenAPI document.
- **Thin handlers.** A handler finds the route, parses input with the shared zod schemas, calls a service, and maps errors to RFC 7807 `problem+json`. Services hold the logic; a `SiteWiseReader` interface is the only thing that talks to SiteWise (FR-API-11).
- **Everything resolves through the site's asset tree.** Both services build the hierarchy from the root asset and cache it in memory for 5 minutes. An asset or property outside that tree is a 404 even if its ID exists elsewhere in the account, so the API cannot be used to read arbitrary SiteWise data. Parent lookups and key lookups come from the cached index instead of extra SiteWise calls.
- **Least-privilege roles per function.** The catalog role can describe assets and models. The telemetry role can additionally read values, history, and aggregates. Neither can write.

## Why separate functions

- **Blast radius:** a bug or a throttling storm in time-series reads does not take down the catalog or the health check.
- **Different profiles:** catalog responses are cacheable and small; telemetry reads fan out to SiteWise and are latency-sensitive. They can be sized, alarmed on, and deployed independently.
- **Clear permissions:** each role shows exactly what that service may do.

Two functions rather than one per route keeps cold starts and deployment units manageable; at this size, one function per route would add cost and operational noise without a benefit.

## Consequences

- Both functions build the tree, so a cold telemetry function makes the same few SiteWise describe calls the catalog does. With 8 assets this is cheap. At scale the tree would move to a shared cache (for example DynamoDB, refreshed on asset model changes) instead of per-function memory.
- The tree cache means a newly added asset appears in the API within 5 minutes of deployment.
