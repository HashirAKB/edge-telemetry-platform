# ADR 0013: Hand-written test doubles instead of aws-sdk-client-mock

- Status: Accepted
- Date: 2026-10-10

## Context

SRS section 8 suggests `aws-sdk-client-mock` for tests, with the instruction to check each tool before adopting it. On 2026-10-10 its latest release was 4.1.0 from October 2024, with no release since, and it pins `sinon` 18.

## Decision

Do not adopt it. Tests use two small, typed doubles instead:

- **`FakeSiteWise`** implements the `SiteWiseReader` interface with an in-memory copy of the real topology and models (8 assets, 4 models). Service and handler tests run against it.
- **A fake `send`** that answers by command class name tests `SdkSiteWiseReader`, the only module that uses the AWS SDK: chunking at 128 entries, pagination, field mapping, and sparse responses.

## Why

- FR-API-11 already requires an injectable SiteWise client, so the seam exists anyway.
- No dependency that might lag behind AWS SDK releases.
- The fake reader models SiteWise in domain terms, which makes service tests read like the behavior they check.

## Consequences

- The fake `send` matches on class names, so a renamed SDK command would fail those tests loudly rather than silently passing, which is the desired failure mode.
- Behaviour that only real SiteWise shows (IAM, quotas, timing) is covered by the deployed smoke test, not unit tests.
