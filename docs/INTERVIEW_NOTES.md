# Interview notes

Questions an interviewer is likely to ask about this repo, with answers I can explain in my own words. Updated at the end of every build phase.

## Phase 1: Monorepo foundation

**Q: Why a monorepo with pnpm workspaces instead of separate repos?**
The simulator, the CDK infrastructure, and the query API all depend on the same contracts: plant topology, measurement names, MQTT topic format, and API schemas. Keeping them in one repo with a `shared` package means a contract change is one pull request that updates the producer, the infrastructure, and the consumer together, and CI checks all of them at once. pnpm workspaces link local packages without publishing them, and pnpm's strict `node_modules` layout stops a package from importing a dependency it never declared. At larger scale I would add build caching (Turborepo or Nx) and per-package CI filtering, but five packages do not need it yet.

**Q: How do the packages consume each other without a build step?**
Each package exports a custom `@etp/source` condition pointing at its TypeScript source. TypeScript, Vitest, and the CDK app are configured to prefer that condition, so typechecking, tests, and `cdk synth` read source directly. Real builds still use the normal `dist/` export, for example when the simulator is packaged into a Docker image. This keeps the inner loop fast and avoids stale `dist/` bugs.

**Q: What does CI check, and why run `cdk synth` in CI?**
Lint (typed ESLint rules), Prettier format check, typecheck, build, unit tests with coverage thresholds (80 percent on shared, simulator, and api), `cdk synth`, and a separate gitleaks job that scans the full git history for secrets. Synth catches infrastructure errors (invalid construct props, missing context, broken imports) before anyone runs a deploy. It needs no AWS credentials, so it is safe to run on every pull request. The workflow token is read-only by default.

**Q: Why TypeScript 6 when TypeScript 7 is out?**
TypeScript 7 is the native Go rewrite of the compiler. The typed lint rules come from `typescript-eslint`, which currently supports TypeScript below 6.1. Typed linting catches real bugs like unhandled promises, so I chose the version every tool supports and recorded the upgrade as a follow-up in ADR 0010. The general point: "latest" is not the same as "latest that works with the rest of the toolchain", so check peer dependencies before upgrading.

**Q: What are CDK feature flags and why set them on day one?**
Feature flags let CDK change default behavior without breaking existing apps. New behavior is opt-in through `cdk.json` context. Some flags change logical IDs or resource properties, and flipping them after deploy can replace resources. Setting the recommended values before anything is deployed means the project starts on current defaults for free. One concrete example in this repo is `explicitStackTags`, which made `Tags.of(app)` stop tagging stacks. I caught it with a test that checks the synthesized tags.

**Q: How would this setup change for a larger team?**
Add CODEOWNERS per package, required status checks and branch protection on `main`, Renovate or Dependabot for pinned versions, remote build caching, and separate deploy pipelines per stack with manual approval for production. The current setup is right-sized for one engineer and a reference build.

## Phase 2: Shared contracts

**Q: What does "single source of truth for topology" mean in this repo, concretely?**
`packages/shared/src/topology.ts` lists the site, lines, and machines once. Topic names, IoT rule SQL, SiteWise property aliases, the alias template inside the rule, and the simulator's device list are all computed from it by small helper functions. Adding a machine is a one-line change. The topology is validated with zod when the module loads, so a typo (uppercase ID, duplicate machine) fails the build and `cdk synth` immediately, not at deploy time.

**Q: What is a SiteWise property alias and why use it?**
An alias is a string name for one asset property's data stream, for example `/kochi-01/line-a/pump-01/temperature_c`. The ingest API accepts an alias instead of the asset and property UUIDs, which only exist after deploy. Devices publish to a topic, the IoT rule rebuilds the alias from topic segments with `${topic(n)}`, and SiteWise resolves it. Devices never need cloud IDs. A unit test proves the rule template and the infra alias builder produce identical strings for every measurement of every machine, so this contract is checked without deploying.

**Q: Why put the version in both the topic and the payload?**
The topic version (`telemetry/v1/...`) lets a `v2` contract get its own rules and run side by side while devices migrate; nothing has to branch inside one rule. The payload `v` field is a guard that a message matches the tree it was published on. Schemas are strict, so an unexpected field or metric is an error on the device, before it is published, not a silent drop in the cloud.

**Q: Why device timestamps, and what limits apply?**
Buffered data replayed after an outage must land at the time it was measured, not when it arrived, or windowed metrics and history would be wrong. The rule converts payload `ts` (epoch ms) into SiteWise seconds plus nanos. SiteWise accepts values from 7 days in the past to 10 minutes in the future, inclusive. The SRS said 5 minutes, but the current API reference says 10, so I followed the docs and recorded it in ADR 0004. The schema also rejects timestamps before 2020 to catch the seconds-versus-milliseconds bug at the source.

**Q: Is a duplicate QoS 1 delivery a problem?**
No. QoS 1 is at-least-once, so duplicates can happen. SiteWise overwrites a value that has the same timestamp and quality, so a duplicate becomes an idempotent write and does not create an extra data point. Using device timestamps is what makes this work.

**Q: How do the API schemas stay in sync with the API Gateway routes and the OpenAPI document?**
Routes are data: `API_ROUTES` in `shared` lists method, path, owning service, auth requirement, and the zod schemas for params, query, and response. The OpenAPI 3.1 document is generated from that list, and the API stack will build API Gateway resources from the same list in Phase 5. Handlers validate requests with the same schemas, and consumers import the inferred TypeScript types. One definition gives runtime validation, types, docs, and infrastructure, so none of them can drift.
