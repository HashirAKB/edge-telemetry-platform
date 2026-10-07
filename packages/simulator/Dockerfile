# syntax=docker/dockerfile:1
# Sensor simulator image (FR-SIM-10). Build from the repository root:
#   docker build -f packages/simulator/Dockerfile -t etp-simulator .
#
# Debian slim, not Alpine: the AWS CRT native module used by aws-iot-device-sdk-v2 needs glibc.
# Base pinned by digest so rebuilds are reproducible; bump deliberately.
ARG NODE_IMAGE=node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION=12.9.1
# Set by BuildKit: amd64 (EC2 t3) or arm64 (Graviton, Raspberry Pi 64-bit).
ARG TARGETARCH
ENV CI=true
RUN npm install --global "pnpm@${PNPM_VERSION}"
WORKDIR /repo

# Manifests first, so the dependency layer is cached until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/simulator/package.json packages/simulator/
RUN pnpm install --frozen-lockfile --filter "@etp/simulator..."

COPY packages/shared/src packages/shared/src
COPY packages/simulator/src packages/simulator/src

# One-file bundle with shared and zod inlined; only the IoT SDK stays external (native code).
RUN pnpm --filter @etp/simulator run bundle

# Production node_modules from the lockfile, then remove what the image never loads:
# packages already inlined into the bundle, AWS CRT binaries for other platforms, the CRT
# browser build, type declarations, source maps, and docs.
RUN pnpm --filter @etp/simulator deploy --prod /deploy \
 && cd /deploy/node_modules/.pnpm \
 && rm -rf zod@* yaml@* openapi3-ts@* @asteasolutions+* @etp+shared* @types+node@* undici-types@* \
 && case "${TARGETARCH:-amd64}" in \
      amd64) keep=linux-x64-glibc ;; \
      arm64) keep=linux-arm64-glibc ;; \
      *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && crt="$(echo aws-crt@*/node_modules/aws-crt)" \
 && find "$crt/dist/bin" -mindepth 1 -maxdepth 1 ! -name "$keep" -exec rm -rf {} + \
 && rm -rf "$crt/dist.browser" \
 && find /deploy/node_modules -type f \( -name '*.d.ts' -o -name '*.map' -o -name '*.md' \) -delete \
 && find /deploy/node_modules -xtype l -delete

# The slim base has no CA bundle, and the CRT needs a trust anchor for TLS. Trust only
# Amazon Root CA 1 (signs AWS IoT Core endpoints), verified by checksum. Only the dev MQTT
# transport uses it; under Greengrass the nucleus owns the TLS connection.
FROM ${NODE_IMAGE} AS ca
ADD --checksum=sha256:2c43952ee9e000ff2acc4e2ed0897c0a72ad5fa72c3d934e81741cbd54f05bd1 \
    https://www.amazontrust.com/repository/AmazonRootCA1.pem /AmazonRootCA1.pem

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    CA_PATH=/app/AmazonRootCA1.pem
WORKDIR /app
# ADD from a URL creates a 0600 root-owned file; make it readable by the runtime user.
COPY --from=ca --chmod=0644 /AmazonRootCA1.pem ./AmazonRootCA1.pem
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /repo/packages/simulator/bundle/main.mjs /repo/packages/simulator/bundle/main.mjs.map ./
# The image's built-in unprivileged user; files stay root-owned and read-only to it.
USER node
# Node is PID 1 and handles SIGTERM itself (graceful flush, FR-SIM-8).
ENTRYPOINT ["node", "--enable-source-maps", "main.mjs"]
