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
