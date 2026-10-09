# ADR 0009: Grafana instead of SiteWise Monitor for plant dashboards

- Status: Accepted (Grafana itself not built yet: stretch goal S1)
- Date: 2026-10-09

## Context

Operators and application teams want to see the asset hierarchy and its values as charts. AWS IoT SiteWise has a built-in dashboard feature, SiteWise Monitor (portals, projects, dashboards). AWS stopped offering it to new customers from 7 November 2025. Existing customers can keep using it, and AWS recommends Amazon Managed Grafana with the SiteWise data source, Grafana Cloud, or self-hosted Grafana instead ([SiteWise Monitor availability change](https://docs.aws.amazon.com/iot-sitewise/latest/appguide/iotsitewise-monitor-availability-change.html)). This account is new, so Monitor is not an option at all.

## Decision

- Plant dashboards use **Grafana with the AWS IoT SiteWise data source plugin**, run locally with Docker Compose (stretch goal S1), reading the same asset hierarchy the API exposes.
- **Not Amazon Managed Grafana** for this build: it bills per active user per month and needs IAM Identity Center. That suits a team, not a single-person reference build that runs on demand.
- Until S1 is built, two views exist: the CloudWatch dashboard `etp-overview` for platform health (ingest rate, rule failures, freshness, API latency, Lambda errors) and the query API for the data itself.

## Consequences

- Platform health (CloudWatch) and plant data (Grafana) are separate views. That is deliberate: the first is for whoever runs the platform, the second for the people who use its data.
- Local Grafana needs AWS credentials on the machine that runs it. For a shared deployment, use Amazon Managed Grafana with a read-only role scoped to the SiteWise assets.
- Application teams that build their own UI should use the query API rather than Grafana. The API is the supported contract (SRS 1.3); Grafana reads SiteWise directly and is a tool for operators.
