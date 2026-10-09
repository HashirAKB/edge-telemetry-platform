# ADR 0014: Edge host on t2.micro with manual Greengrass provisioning

- Status: Accepted
- Date: 2026-10-09

## Context

FR-EDGE-6 asks for a `t3.small` core host whose user data installs Greengrass "with automatic provisioning using the documented minimal installer permissions". The first deploys hit three problems.

## Findings and decisions

### 1. Instance type: t2.micro, because the account's vCPU quota is 1

The account's quota for running on-demand standard instances is **1 vCPU**; `t3.small` needs 2. One early launch succeeded, but later launches were refused. `t2.micro` (1 vCPU, 1 GiB) fits. To make 1 GiB enough for the nucleus JVM, Docker, and the Node container:

- a 1 GB swap file is created first in user data;
- the nucleus heap is capped with `jvmOptions: -Xmx256m -Xms64m` in the deployment.

Measured on the device: nucleus resident memory about 140 MB, about 480 MB available, swap barely used. With a 1 vCPU quota, any change that replaces the instance must be done as destroy then deploy, because CloudFormation creates the replacement before deleting the old one.

A capacity shortage for `t2.micro` in `ap-south-1a` also appeared once, so the single subnet's availability zone is configurable (`-c edgeAz=...`, default `ap-south-1b`).

### 2. Manual provisioning instead of the installer's automatic mode

With `--provision true`, the installer:

- needs `iot:AttachThingPrincipal` on the new certificate as well as the thing (the documented policy uses `*`);
- **creates and attaches an extra IAM policy (`<role>Access`) to the token exchange role even when the role already exists**, granting broad CloudWatch Logs and S3 permissions.

Allowing the second would widen the least-privilege token exchange role and leave an IAM policy outside CloudFormation. Instead the host uses the documented **manual provisioning** path: user data creates the certificate with `aws iot create-keys-and-certificate`, creates the thing, attaches the CDK-managed policy, adds the thing to the group, writes the nucleus `config.yaml`, and runs the installer with `--init-config`. The instance role has **no IAM permissions at all**, only five IoT actions scoped to the named thing, group, and policy (the certificate ID is unknown in advance, so `cert/*`).

### 3. Supply chain

The nucleus zip is verified with `jarsigner` before installation, and Amazon Root CA 1 is checked against its SHA-256 checksum.

## Consequences

- The thing and certificate are created on the device, outside CloudFormation. `pnpm edge:deprovision` removes them; it runs after destroying `EtpEdgeHost` and before destroying `EtpEdge`.
- A production fleet would use fleet provisioning by claim or a hardware security module instead of keys generated in the cloud and written to disk.
- Requesting a higher vCPU quota would allow returning to `t3.small`; nothing else depends on the instance type.
