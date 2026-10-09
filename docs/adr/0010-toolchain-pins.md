# ADR 0010: Toolchain versions and monorepo wiring

- Status: Accepted
- Date: 2026-10-07

## Context

SRS section 8 asks for current stable versions, pinned, and checked before adoption. Checking the registry on 2026-10-07 turned up three points where "latest" and "works together" differ, plus a CDK behavior change that affects tagging.

## Decisions

1. **TypeScript 6.0.3, not 7.0.** TypeScript 7.0 (the native Go compiler) is the newest release, but `typescript-eslint` 8.71 declares support for `typescript >=4.8.4 <6.1.0`. Typed linting is a hard requirement (NFR-6), so we stay on 6.0 until `typescript-eslint` supports 7.
2. **Node.js 24 LTS**, pinned by `.nvmrc` and `engines.node` (`>=24 <25`). Vitest 5 requires Node `^22.12 || ^24 || >=26`, and Lambda runs `nodejs24.x`, so local, CI, and runtime all match.
3. **pnpm 12.9.1**, pinned by the `packageManager` field and read by `pnpm/action-setup` in CI. pnpm 12 refuses to install when a dependency's build script has not been approved; `esbuild` is approved in `pnpm-workspace.yaml` (`allowBuilds`) because it downloads its platform binary in `postinstall`.
4. **Source-first workspace resolution.** Each package exports a custom `@etp/source` condition that points at `src/*.ts`. TypeScript (`customConditions`), Vitest (`resolve.conditions`), and the CDK app (`tsx --conditions=@etp/source`) all use it, so typecheck, tests, and synth never depend on a prior build. The default export condition still points at `dist/` for real builds (simulator Docker image).
5. **CDK feature flags set to recommended values** at project start with `cdk flags --set --recommended --unconfigured`. Changing flags after resources exist can force resource replacement, so this is cheapest on day one.
6. **Stack tags are passed as stack props**, not with `Tags.of(app)`. The recommended `@aws-cdk/core:explicitStackTags` flag makes `Tags.of(...)` on a stack a no-op; CloudFormation propagates stack tags to every resource instead. An infra test asserts the tags reach the cloud assembly.

## Consequences

- Upgrading to TypeScript 7 is a tracked follow-up, gated on `typescript-eslint`.
- `packages/infra/cdk.json` is excluded from Prettier because `cdk flags` rewrites it in its own format.
- `target-partitions` has no recommended value and stays at its default. `defaultCrossStackReferences` was later set explicitly to `strong` (ADR 0012).

## Addendum (2026-10-10): `exactOptionalPropertyTypes` is off in `packages/infra` only

The AWS CDK type definitions are not written for `exactOptionalPropertyTypes` (for example, `Vpc` is not assignable to `IVpc` because `vpnGatewayId` is `string | undefined` on one and `string` on the other). Rather than cast at every call site, the option is disabled for the infra package only; every other package keeps it.
