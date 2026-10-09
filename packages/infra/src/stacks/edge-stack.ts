import { createHash } from 'node:crypto';
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as greengrass from 'aws-cdk-lib/aws-greengrassv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import type { Construct } from 'constructs';
import { DEFAULT_PUBLISH_INTERVAL_MS, PUBLISH_TOPIC_FILTER, TOPIC_PREFIX } from '@etp/shared';

/** Names shared with the edge host's installer (SRS 6.2). */
export const EDGE = {
  thingGroup: 'etp-edge-cores',
  coreThingName: 'etp-edge-core-01',
  corePolicy: 'etp-edge-core-policy',
  tesRole: 'etp-edge-tes-role',
  tesRoleAlias: 'etp-edge-tes-alias',
  component: 'com.hashirakb.etp.SensorSimulator',
  container: 'etp-sensor-simulator',
} as const;

/**
 * Public component versions, pinned so a redeploy never pulls an unexpected nucleus update
 * (Greengrass docs recommend pinning). Checked against ap-south-1 on 2026-10-09.
 */
export const GREENGRASS_VERSIONS = {
  nucleus: '2.18.3',
  diskSpooler: '1.0.9',
  dockerApplicationManager: '2.0.17',
  tokenExchangeService: '2.0.3',
} as const;

export const NUCLEUS_JVM_OPTIONS = '-Xmx256m -Xms64m';

/** MQTT spool on disk (ADR 0005): ~7 h of default traffic; when full, new messages are rejected. */
export const SPOOLER_MAX_BYTES = 10 * 1024 * 1024;

export interface EdgeStackProps extends StackProps {
  readonly repository: ecr.IRepository;
  /** Immutable image tag pushed by scripts/publish-simulator-image.ts (the git short SHA). */
  readonly imageTag: string;
  readonly publishIntervalMs?: number;
}

/**
 * Greengrass cloud side (SRS 6.2, section 10): thing group, token exchange role and alias,
 * the core device's IoT policy, the simulator component, and the deployment to the group.
 */
export class EdgeStack extends Stack {
  readonly componentVersion: string;
  readonly recipe: Record<string, unknown>;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    const arn = (service: string, resource: string) =>
      `arn:${this.partition}:${service}:${this.region}:${this.account}:${resource}`;

    const group = new iot.CfnThingGroup(this, 'CoreGroup', { thingGroupName: EDGE.thingGroup });

    // Token exchange role: what components may do with AWS credentials. Only pulls this image.
    const tesRole = new iam.Role(this, 'TokenExchangeRole', {
      roleName: EDGE.tesRole,
      assumedBy: new iam.ServicePrincipal('credentials.iot.amazonaws.com'),
      description: 'Greengrass core device credentials: pull the simulator image only',
    });
    tesRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        resources: [props.repository.repositoryArn],
      }),
    );
    tesRole.addToPolicy(
      new iam.PolicyStatement({
        // GetAuthorizationToken has no resource-level permissions; AWS requires "*".
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    const roleAlias = new iot.CfnRoleAlias(this, 'TokenExchangeRoleAlias', {
      roleAlias: EDGE.tesRoleAlias,
      roleArn: tesRole.roleArn,
      credentialDurationSeconds: 3600,
    });

    // Minimal core device policy (Greengrass device-auth docs) plus publish to telemetry.
    // Thing policy variables are not supported for core devices, so the thing is named.
    const thing = EDGE.coreThingName;
    const topic = (t: string) => arn('iot', `topic/${t}`);
    const filter = (t: string) => arn('iot', `topicfilter/${t}`);
    new iot.CfnPolicy(this, 'CorePolicy', {
      policyName: EDGE.corePolicy,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: 'iot:Connect', Resource: arn('iot', `client/${thing}*`) },
          {
            Effect: 'Allow',
            Action: ['iot:Publish', 'iot:Receive'],
            Resource: [
              topic(`$aws/things/${thing}/greengrass/health/json`),
              topic(`$aws/things/${thing}/greengrassv2/health/json`),
              topic(`$aws/things/${thing}/jobs/*`),
              topic(`$aws/things/${thing}/shadow/*`),
            ],
          },
          { Effect: 'Allow', Action: 'iot:Publish', Resource: topic(`${TOPIC_PREFIX}/*`) },
          {
            Effect: 'Allow',
            Action: 'iot:Subscribe',
            Resource: [
              filter(`$aws/things/${thing}/jobs/*`),
              filter(`$aws/things/${thing}/shadow/*`),
            ],
          },
          {
            Effect: 'Allow',
            Action: 'iot:AssumeRoleWithCertificate',
            Resource: roleAlias.attrRoleAliasArn,
          },
          {
            Effect: 'Allow',
            Action: [
              'greengrass:GetComponentVersionArtifact',
              'greengrass:ResolveComponentCandidates',
              'greengrass:GetDeploymentConfiguration',
              'greengrass:ListThingGroupsForCoreDevice',
            ],
            Resource: '*',
          },
        ],
      },
    });

    // The simulator as a Docker component that publishes through Greengrass IPC (ADR 0006).
    const image = `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${props.repository.repositoryName}:${props.imageTag}`;
    const build = (version: string, imageRef: string) =>
      simulatorRecipe(version, imageRef, props.publishIntervalMs ?? DEFAULT_PUBLISH_INTERVAL_MS);
    // Component versions are immutable: derive the version from the recipe content, so any
    // change (new image tag, new defaults) produces a new version and an unchanged one does not.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(build('0.0.0', `etp/simulator:${props.imageTag}`)))
      .digest('hex');
    // Greengrass caps each version number at 999999 (recipe reference), hence the modulo.
    this.componentVersion = `1.0.${String(parseInt(fingerprint.slice(0, 8), 16) % 1_000_000)}`;
    this.recipe = build(this.componentVersion, image);

    const component = new greengrass.CfnComponentVersion(this, 'SimulatorComponent', {
      inlineRecipe: this.toJsonString(this.recipe),
    });

    new greengrass.CfnDeployment(this, 'Deployment', {
      targetArn: group.attrArn,
      deploymentName: 'etp-edge',
      components: {
        'aws.greengrass.Nucleus': {
          componentVersion: GREENGRASS_VERSIONS.nucleus,
          configurationUpdate: {
            merge: JSON.stringify({
              // Bound the nucleus heap on the 1 GiB edge host (ADR 0014).
              jvmOptions: NUCLEUS_JVM_OPTIONS,
              mqtt: {
                spooler: {
                  storageType: 'Disk',
                  pluginName: 'aws.greengrass.DiskSpooler',
                  maxSizeInBytes: SPOOLER_MAX_BYTES,
                  keepQos0WhenOffline: false,
                },
              },
            }),
          },
        },
        'aws.greengrass.DiskSpooler': { componentVersion: GREENGRASS_VERSIONS.diskSpooler },
        'aws.greengrass.DockerApplicationManager': {
          componentVersion: GREENGRASS_VERSIONS.dockerApplicationManager,
        },
        'aws.greengrass.TokenExchangeService': {
          componentVersion: GREENGRASS_VERSIONS.tokenExchangeService,
        },
        [EDGE.component]: { componentVersion: component.attrComponentVersion },
      },
      deploymentPolicies: {
        failureHandlingPolicy: 'ROLLBACK',
        componentUpdatePolicy: { action: 'NOTIFY_COMPONENTS', timeoutInSeconds: 60 },
      },
    });

    new CfnOutput(this, 'ComponentVersion', { value: this.componentVersion });
    new CfnOutput(this, 'CoreThingName', { value: EDGE.coreThingName });
  }
}

/** The component recipe (SRS FR-EDGE-3). Exported for tests. */
export function simulatorRecipe(
  version: string,
  image: string,
  intervalMs: number,
): Record<string, unknown> {
  const socket = '$AWS_GG_NUCLEUS_DOMAIN_SOCKET_FILEPATH_FOR_COMPONENT';
  return {
    RecipeFormatVersion: '2020-01-25',
    ComponentName: EDGE.component,
    ComponentVersion: version,
    ComponentDescription:
      'Simulated industrial sensors publishing telemetry through Greengrass IPC',
    ComponentPublisher: 'Hashir Ahmed K B',
    ComponentDependencies: {
      'aws.greengrass.DockerApplicationManager': {
        VersionRequirement: '>=2.0.0 <3.0.0',
        DependencyType: 'HARD',
      },
      'aws.greengrass.TokenExchangeService': {
        VersionRequirement: '>=2.0.0 <3.0.0',
        DependencyType: 'HARD',
      },
    },
    ComponentConfiguration: {
      DefaultConfiguration: {
        // Read by the simulator over IPC; a deployment merge changes it live (FR-EDGE-4).
        simulator: { intervalMs, bufferMax: 5000, logLevel: 'info', faults: [], idleWindows: [] },
        accessControl: {
          'aws.greengrass.ipc.mqttproxy': {
            [`${EDGE.component}:mqttproxy:1`]: {
              policyDescription: 'Publish telemetry to AWS IoT Core, and nothing else',
              operations: ['aws.greengrass#PublishToIoTCore'],
              resources: [PUBLISH_TOPIC_FILTER],
            },
          },
        },
      },
    },
    Manifests: [
      {
        Platform: { os: 'linux' },
        Lifecycle: {
          // IPC from Docker: mount the nucleus socket and pass SVCUID and the socket path
          // (Greengrass "Run a Docker container" docs). --rm and a fixed name let Shutdown stop
          // the container; without it, stopping the component kills only the docker client.
          Run: {
            Script: [
              `docker rm -f ${EDGE.container} 2>/dev/null || true;`,
              `exec docker run --rm --name ${EDGE.container}`,
              `-v ${socket}:${socket}`,
              '-e SVCUID -e AWS_GG_NUCLEUS_DOMAIN_SOCKET_FILEPATH_FOR_COMPONENT',
              '-e TRANSPORT=ipc',
              image,
            ].join(' '),
          },
          Shutdown: { Script: `docker stop --time 10 ${EDGE.container} || true` },
        },
        Artifacts: [{ URI: `docker:${image}` }],
      },
    ],
  };
}
