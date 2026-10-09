# Edge-to-Cloud Telemetry Platform

[![CI](https://github.com/HashirAKB/edge-telemetry-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/HashirAKB/edge-telemetry-platform/actions/workflows/ci.yml)

Reference platform for industrial telemetry on AWS: a Greengrass v2 edge device runs a containerized sensor simulator,
AWS IoT Core rules route measurements into AWS IoT SiteWise asset models, and TypeScript Lambda services expose a
typed query API for application teams. Infrastructure is defined in AWS CDK.

Status: in active development. See docs/SRS.md for the full specification.

## Query API

Application teams read telemetry through a typed REST API and never deal with MQTT topics, device certificates, or SiteWise property IDs. The full contract is in [`docs/openapi.yaml`](docs/openapi.yaml), generated from the same zod schemas the Lambda handlers validate with.

| Method and path                                               | Returns                                                                      |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /v1/health`                                              | Build version and SiteWise reachability (no API key)                         |
| `GET /v1/assets/tree`                                         | Site, lines, and machines with every property (kind, unit, data type, alias) |
| `GET /v1/assets/{assetId}`                                    | One asset with its parent and children                                       |
| `GET /v1/assets/by-key/{siteId}/{lineId}/{machineId}`         | Resolve plant IDs such as `kochi-01/line-a/pump-01` to an asset              |
| `GET /v1/assets/{assetId}/latest`                             | Latest value of every property, plus a `stale` flag                          |
| `GET /v1/assets/{assetId}/properties/{propertyId}/history`    | Raw values, up to 24 h per request, paginated                                |
| `GET /v1/assets/{assetId}/properties/{propertyId}/aggregates` | Averages, min, max, and more at `1m`, `15m`, `1h`, or `1d`                   |

Errors use RFC 7807 `application/problem+json`. Every route except health needs the `x-api-key` header; the usage plan allows 10 requests per second and 10,000 per day.

```bash
# After deploying the stacks, read the URL and key (the key value is never in stack outputs):
export AWS_PROFILE=<your-profile>
API=$(aws cloudformation describe-stacks --stack-name EtpApi \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
KEY_ID=$(aws cloudformation describe-stacks --stack-name EtpApi \
  --query "Stacks[0].Outputs[?OutputKey=='ApiKeyId'].OutputValue" --output text)
KEY=$(aws apigateway get-api-key --api-key "$KEY_ID" --include-value --query value --output text)

curl -s "${API}v1/health"
curl -s -H "x-api-key: $KEY" "${API}v1/assets/tree"

PUMP=$(curl -s -H "x-api-key: $KEY" "${API}v1/assets/by-key/kochi-01/line-a/pump-01" | jq -r .assetId)
curl -s -H "x-api-key: $KEY" "${API}v1/assets/$PUMP/latest"

TEMP=$(curl -s -H "x-api-key: $KEY" "${API}v1/assets/$PUMP" | jq -r '.properties[] | select(.name=="temperature_c") | .propertyId')
FROM=$(date -u -d '-30 min' +%Y-%m-%dT%H:%M:%SZ); TO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -s -H "x-api-key: $KEY" \
  "${API}v1/assets/$PUMP/properties/$TEMP/aggregates?from=$FROM&to=$TO&resolution=1m&types=AVERAGE,MAXIMUM"
```

`pnpm smoke` runs these checks end to end, plus error cases and latency percentiles.
