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
Buffered data replayed after an outage must land at the time it was measured, not when it arrived, or windowed metrics and history would be wrong. The rule converts payload `ts` (epoch ms) into SiteWise seconds plus nanos. SiteWise accepts values from 7 days in the past to a few minutes in the future. Two AWS pages disagree on the future bound (the API reference says 10 minutes, the IoT rule action page says 5), and our data arrives through the rule action, so I used the stricter 5 minutes and recorded both sources in ADR 0004. The schema also rejects timestamps before 2020 to catch the seconds-versus-milliseconds bug at the source.

**Q: Is a duplicate QoS 1 delivery a problem?**
No. QoS 1 is at-least-once, so duplicates can happen. SiteWise overwrites a value that has the same timestamp and quality, so a duplicate becomes an idempotent write and does not create an extra data point. Using device timestamps is what makes this work.

**Q: How do the API schemas stay in sync with the API Gateway routes and the OpenAPI document?**
Routes are data: `API_ROUTES` in `shared` lists method, path, owning service, auth requirement, and the zod schemas for params, query, and response. The OpenAPI 3.1 document is generated from that list, and the API stack will build API Gateway resources from the same list in Phase 5. Handlers validate requests with the same schemas, and consumers import the inferred TypeScript types. One definition gives runtime validation, types, docs, and infrastructure, so none of them can drift.

## Phase 3: Sensor simulator

**Q: How do you make simulated sensor data realistic but reproducible?**
Each value is a base level scaled by machine load, plus slow drift, a daily cycle, and Gaussian noise, clamped to physical limits. Load wanders with a mean-reverting random walk on top of a shift-length cycle, and temperature follows load through a first-order lag, so a load change shows up in flow at once and in temperature over minutes. Randomness comes from a seeded generator, with a separate stream per machine and per signal, so the same seed always produces the same series. Tests and demos are repeatable, and adding a machine does not change the others.

**Q: Walk me through the fault injection.**
Four faults, scheduled by start offset and duration in config: bearing wear ramps vibration up to a multiple of normal, overheat steps temperature up and keeps rising, a stuck sensor freezes one value, and a dropout stops the machine publishing. Status turns FAULT only when an active fault pushes its signal past a threshold shared with the cloud (vibration above 7.1 mm/s, or an overheat temperature per machine type). A stuck sensor stays RUNNING on purpose. In a real plant a frozen value looks healthy, so detecting it is an analytics job, which makes it a good demo of why platform-level monitoring matters.

**Q: What happens when publishing fails?**
Every message goes through one ordered queue with one message in flight. If a publish fails, the message goes back to the front and the queue retries after an exponential backoff with full jitter, so many devices that failed together do not retry in lockstep. The queue has a hard size limit and drops the oldest message when full, which bounds memory on a small edge device. This buffer handles local failures like the Greengrass nucleus restarting. Network outages are handled by the MQTT client and, on the edge, the Greengrass disk spooler. On SIGTERM the simulator stops sampling, flushes for up to 5 seconds, and exits cleanly.

**Q: How do you detect lost messages?**
Every message carries `seq`, which increases by one per message a machine actually emits. It does not advance during a simulated dropout, so a gap in `seq` downstream means a message was lost in transit, not that the device was off. The outage test in Phase 6 uses this to prove the spooler loses nothing.

**Q: How did you keep the image under 250 MB, and what did testing the image catch?**
The `node:24-slim` base alone is 230 MB, so a naive install came to about 275 MB. The app is bundled into one file with esbuild, only the AWS IoT SDK stays in `node_modules`, and the build strips everything the image never loads, mainly AWS CRT native binaries for six other platforms. The result is 246.7 MB, and CI fails the build if it reaches 250 MB. Running MQTT mode inside the container then caught a real bug: the slim base has no CA certificates, so TLS could not work at all. Instead of installing the whole CA bundle, the image trusts only Amazon Root CA 1, verified by checksum, which is smaller and narrows trust to the one CA the device needs.

**Q: Why does the image use Debian slim instead of Alpine?**
The AWS IoT Device SDK uses the AWS Common Runtime, a native module built against glibc. Alpine uses musl, and native modules built for glibc either do not load or need special builds there. Debian slim keeps glibc and is still small. Distroless Node.js would be smaller again and is the documented fallback if the size margin runs out.

## Phase 4: SiteWise models and ingestion

**Q: What is the difference between an asset model and an asset in SiteWise?**
An asset model is the template: which properties a kind of equipment has, their types and units, the formulas for transforms and metrics, and which child models it can contain. An asset is one real thing built from a model, like `pump-01`. Here there are four models (site, line, pump, compressor) and eight assets, one per topology node, all generated from the shared topology. Adding a pump means one more asset of the existing pump model, not a new model.

**Q: Measurement, transform, metric, attribute: what is each?**
A measurement is raw data from the device (`temperature_c`). A transform is computed per incoming data point with no time window (`temperature_f`, or `vibration_alert = gt(vibration, 7.1)`). A metric aggregates over a tumbling time window (`max_vibration_5m`) and can aggregate across child assets through a hierarchy. An attribute is static metadata (`timezone`). Measurements are stored; transforms and metrics are computed by SiteWise, so application teams get derived values without writing stream processing.

**Q: How do hierarchy rollups work, and what did the docs change?**
A line model has hierarchies `pumps` and `compressors`. A line metric uses a variable that points at a property of the child model through a hierarchy, and SiteWise aggregates it over all associated child assets in each window. The docs say a metric's metric inputs must have the same window, so a 5 minute line metric cannot read a 1 minute pump metric as the SRS proposed. Pumps got a 5 minute average, and a unit test now enforces the rule so a bad model fails in CI instead of in CloudFormation.

**Q: The first real data run failed. What happened and how did you fix it?**
Every write was denied with `AccessDeniedException`. The rule's error action logged each failure with the full reason, which is exactly why that error log exists. The rule role followed the AWS IoT docs example: `Resource: "*"` with an `assetHierarchyPath` condition. I tested candidate policies against live traffic, and the first lesson was about method: IAM changes took about 4 minutes to reach the IoT rule engine, so a check 30 seconds after deploying gave me a false pass that I briefly believed. After that I only trusted a policy that had run clean for longer than the delay, starting from a denied state. The result: for aliases on asset properties, SiteWise authorizes the write against the data stream (time-series resource), it supplies the `propertyAlias` condition key but not `assetHierarchyPath`, so the docs example can never work here. The final role can write only to data streams whose alias starts with `/kochi-01/` and to the 5 machine assets by ARN. The broader lesson: docs examples are a starting point, verify against real traffic, and know how long a change takes to take effect before you judge it.

**Q: How do you know the device policy is least privilege?**
A script tries what the device must not be able to do. Publishing to a telemetry topic is accepted. Publishing outside `telemetry/v1/` is rejected by the broker with MQTT reason code 135 (not authorized). Connecting with any client ID other than the thing name is refused. Testing the denials matters as much as testing the allows.

**Q: What does this cost, and what would change at scale?**
About $9 per million device messages here, mostly SiteWise ingestion, which bills each of the 5 values in a message separately. That is 3 cents an hour for 5 machines at a 5 second interval and nothing when idle, so the platform runs on demand. At scale I would batch values per stream on the edge (Stream Manager or buffered ingestion), pick sampling rates per measurement instead of one global interval, and move older data to the cold tier.

## Phase 5: Query API

**Q: Why is the query API two Lambdas and not one, or one per route?**
The catalog (tree, lookups, health) and time-series reads have different shapes: catalog answers are small and cacheable, telemetry reads fan out to SiteWise and are latency-sensitive. Separate functions give separate permissions, alarms, and blast radius, so a throttling storm in history reads cannot take down the health check. One function per route would multiply cold starts and deployment units for no gain at this size.

**Q: How do you stop the API from becoming a generic SiteWise proxy?**
Both services resolve every request through the site's asset tree, built from the root asset and cached for 5 minutes. An asset or property outside that tree returns 404 even if the ID exists elsewhere in the account. The IAM roles are read-only, and the tree also answers parent and key lookups without extra SiteWise calls.

**Q: How are the API contract, validation, and docs kept in sync?**
One set of zod schemas in `shared` defines requests and responses. Handlers validate input with them, consumers import the inferred TypeScript types, the OpenAPI 3.1 file is generated from them, and the API Gateway routes are built from the same route table. CI regenerates the OpenAPI file and fails if the committed copy differs.

**Q: What broke on the first deploy, and what did you learn?**
Every Lambda crashed on startup with `Cannot find module '@smithy/service-error-classification'`. CDK leaves the AWS SDK out of the bundle by default and uses the runtime's copy, and a recommended feature flag also excluded the SDK's `@smithy` internals, which the runtime does not expose. I now bundle the SDK, so production runs the exact locked version the tests use, and an infra test asserts the bundles contain no external SDK imports. I found it with `apigateway test-invoke-method`, which calls the integration directly, while the new API's DNS name was still propagating (my own early lookups had negative-cached the not-yet-published name for 15 minutes). The smoke test then found a second bug unit tests could not: SiteWise rejects query dates with milliseconds ("The date can only be in seconds"), and my unit tests only used whole-second dates. The reader now rounds the start down and the end up, which never drops data because the start is exclusive and the end inclusive, and a regression test sends millisecond dates.

**Q: Why did fresh data show as stale?**
The API flagged pump-01 as stale with data 20 seconds old against a 15 second threshold. The development machine's clock was 25 seconds slow with NTP switched off. Values carry device timestamps by design (ADR 0004), so device clock error shows up directly in the cloud. The staleness check did its job; the fix belongs on the device (time sync), and the Greengrass core runs chrony.

**Q: API keys are not real auth. What would you use in production?**
Correct, API keys identify and meter callers but are shared secrets, not identity. For user-facing apps I would use JWT authorization through an identity provider with scopes per team or site, IAM SigV4 for service-to-service calls, and keep API keys only as a usage-plan handle for throttling and quotas. ADR 0008 has the comparison.
