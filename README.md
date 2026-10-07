# Edge-to-Cloud Telemetry Platform

[![CI](https://github.com/HashirAKB/edge-telemetry-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/HashirAKB/edge-telemetry-platform/actions/workflows/ci.yml)

Reference platform for industrial telemetry on AWS: a Greengrass v2 edge device runs a containerized sensor simulator,
AWS IoT Core rules route measurements into AWS IoT SiteWise asset models, and TypeScript Lambda services expose a
typed query API for application teams. Infrastructure is defined in AWS CDK.

Status: in active development. See docs/SRS.md for the full specification.
