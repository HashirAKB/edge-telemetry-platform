# ADR 0008: API keys and a usage plan for authentication and throttling

- Status: Accepted
- Date: 2026-10-09

## Context

The query API needs a way to identify callers and protect SiteWise from runaway clients. This is a reference build with one consumer at a time (curl, a demo dashboard, the smoke test).

## Decision

API Gateway API keys with a usage plan: every route except `GET /v1/health` requires the `x-api-key` header, and the plan allows 10 requests per second, a burst of 20, and 10,000 requests per day per key (FR-API-9). The key value is never written to stack outputs or logs; tools read it on demand with `apigateway get-api-key --include-value`.

## Trade-offs

| Option                                                           | Good for                                              | Why not here                                                                                             |
| ---------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **API key + usage plan** (chosen)                                | Identifying callers, per-client throttling and quotas | Keys are shared secrets, not user identity. AWS itself says API keys are not an authorization mechanism. |
| IAM (SigV4)                                                      | Service-to-service calls inside AWS                   | Clients need AWS credentials and request signing; awkward for curl and browsers.                         |
| JWT (Cognito or an external IdP) with a Lambda or JWT authorizer | Real user identity, scopes, short-lived tokens        | Needs an identity provider and user management, which is out of scope (SRS 2.3).                         |

## Production direction

For real application teams: JWT authorization for user-facing apps (scopes per team or per site), IAM for backend services, and API keys kept only as a throttling and metering handle per client. The usage plan stays useful either way.
