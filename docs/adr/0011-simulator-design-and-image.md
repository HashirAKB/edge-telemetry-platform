# ADR 0011: Simulator design and container image

- Status: Accepted
- Date: 2026-10-07

## Context

The simulator stands in for real industrial sensors (SRS 6.1). It has to produce believable, reproducible signals, inject faults on demand, survive local publish failures, shut down cleanly, and ship as a Docker image under 250 MB that runs as a Greengrass component (FR-SIM-10).

## Decisions

**Deterministic signals.** A seeded PRNG (mulberry32) replaces `Math.random()`. Each machine and each signal gets its own stream derived from the global seed, the machine ID, and the signal name, so the same seed always gives the same series, and adding a machine does not change the others. Each value is `base * (1 - s + s * load) + drift + daily sine + noise`, clamped to physical limits. Load follows a shift-length cycle plus a mean-reverting random walk, and temperature follows load through a first-order lag.

**Faults change signals, status follows thresholds.** Faults (`bearingWear`, `overheat`, `stuckSensor`, `dropout`) are scheduled by start offset and duration. Status is FAULT only when an active fault has pushed its signal past a threshold shared with the cloud (7.1 mm/s vibration, per-type overheat temperature). A stuck sensor stays RUNNING on purpose: in real plants a frozen value looks healthy, and detecting it belongs in cloud analytics.

**`seq` counts emitted messages only.** During a dropout the machine is "offline" and `seq` does not advance, so any gap in `seq` downstream means a message was lost in transit, not that the device was off.

**One ordered publish path with a bounded buffer.** Every message goes through one queue with one message in flight. On failure the message returns to the front and the drain loop retries with exponential backoff and full jitter (500 ms base, 30 s cap). The queue drops the oldest message when full (default 5,000, about 80 minutes at 5 machines x 1 message / 5 s). This covers local failures such as the Greengrass nucleus restarting; network outages are handled further down by the MQTT client and, on the edge, the Greengrass disk spooler. On SIGTERM the simulator stops sampling, retries without backoff for up to 5 s, closes the transport, and exits 0.

**Logs on stderr.** FR-SIM-9 says logs go to stdout. In `stdout` transport mode the telemetry itself is the stdout stream, so logs go to stderr to keep `pnpm sim:local | jq` clean. Greengrass captures both streams into the component log, so nothing is lost.

**Image.** Multi-stage build on `node:24-slim` (Debian, glibc; the AWS CRT native module does not support musl-based Alpine reliably), pinned by digest. The app is bundled with esbuild into one file with `shared` and `zod` inlined; only `aws-iot-device-sdk-v2` stays in `node_modules`, installed from the lockfile with `pnpm deploy --prod`. The build then removes packages already inlined in the bundle, AWS CRT binaries for other platforms (keeping only the target architecture), the CRT browser build, type declarations, source maps, and docs. The image runs as the base image's unprivileged `node` user.

**Trust only Amazon Root CA 1.** The slim base has no CA bundle, so the CRT cannot open TLS connections at all (found by testing MQTT mode inside the container). Rather than install the system CA bundle, the image adds Amazon Root CA 1, which signs AWS IoT Core endpoints, verified by SHA-256 checksum at build time. This is smaller and narrows trust to the one CA the device needs. Only the dev MQTT transport uses it; under Greengrass the nucleus owns the TLS connection.

## Measured result

|                     | Size     |
| ------------------- | -------- |
| `node:24-slim` base | 230.0 MB |
| Final image         | 246.7 MB |
| Limit (FR-SIM-10)   | 250 MB   |

The base image is 93 percent of the budget, so the margin is thin. CI builds the image on every push and fails if it reaches 250 MB. If a base image update pushes it over, the fallback is a distroless Node.js 24 base (glibc, non-root, roughly 130 MB), which would need its own ADR.

## Consequences

- `docker build` targets the build host architecture by default; `docker buildx build --platform linux/arm64` produces an image for Graviton or a 64-bit Raspberry Pi, and the Dockerfile keeps the matching CRT binary.
- Fault offsets are relative to process start. When Greengrass configuration updates arrive live (Phase 6), offsets will be relative to when the update is applied.
