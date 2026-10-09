# ADR 0006: Simulator as a Docker component using Greengrass IPC

- Status: Accepted
- Date: 2026-10-10

## Context

Containerized edge workloads are the norm: they isolate dependencies and ship the same image to every device. The simulator must publish through the Greengrass nucleus (so it benefits from the spooler and the core's single authenticated connection) rather than hold its own certificate.

## Decision

The simulator runs as the custom component `com.hashirakb.etp.SensorSimulator`:

- **Image** from the private ECR repository, referenced by an **immutable git-SHA tag** as a `docker:` artifact. `aws.greengrass.DockerApplicationManager` pulls it using credentials from `aws.greengrass.TokenExchangeService`; the token exchange role can pull from that one repository only.
- **IPC into the container**, exactly as the Greengrass "Run a Docker container" docs specify: mount the nucleus socket at the path in `AWS_GG_NUCLEUS_DOMAIN_SOCKET_FILEPATH_FOR_COMPONENT`, and pass `SVCUID` and that variable into the container. The container needs no network credentials; `SVCUID` authenticates it to the nucleus.
- **Authorization**: `accessControl` allows only `aws.greengrass#PublishToIoTCore` on `telemetry/v1/#`.
- **Lifecycle**: `Run` starts the container in the foreground with a fixed name and `--rm`; `Shutdown` runs `docker stop`. Without the Shutdown step, stopping the component kills only the docker client and the container keeps running.
- **Configuration** under the `simulator` key of the component configuration is read over IPC (`GetConfiguration`) and watched (`SubscribeToConfigurationUpdate`). A deployment configuration merge (`pnpm edge:fault`) changes faults or the interval live, without rebuilding the image (FR-EDGE-4), and `seq` continues across the change.
- **Version**: component versions are immutable, so the version is derived from a hash of the recipe. A new image tag or new defaults produce a new version automatically; an unchanged recipe keeps its version. Greengrass caps each version number at 999999.

## Verified on the device

- The container connected over IPC and published for all 5 machines as the image's non-root `node` user; the socket did not need a matching UID.
- `docker ps` on the core shows `etp/simulator:<sha>`; the component log shows the simulator's structured logs (Greengrass captures stdout and stderr).

## Consequences

- A component pointing at a missing image only fails on the device, so the CDK app refuses to synthesize with real credentials unless an image tag is given.
- The simulator can also run without Greengrass (`stdout`, `mqtt` transports) for local work and tests.
