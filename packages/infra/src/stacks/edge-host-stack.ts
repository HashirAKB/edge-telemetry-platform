import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { EDGE, GREENGRASS_VERSIONS } from './edge-stack.js';

/**
 * Optional EC2 host for the Greengrass core (FR-EDGE-6), created only with -c edgeHost=ec2.
 * No inbound ports: operators use SSM Session Manager. Destroy it when not demoing.
 */
export class EdgeHostStack extends Stack {
  readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const arn = (service: string, resource: string) =>
      `arn:${this.partition}:${service}:${this.region}:${this.account}:${resource}`;

    // One public subnet and no NAT gateway: outbound only, nothing billable when stopped.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });
    const securityGroup = new ec2.SecurityGroup(this, 'CoreSecurityGroup', {
      vpc,
      description: 'Greengrass core: outbound only, no inbound rules',
      allowAllOutbound: true,
    });

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Greengrass core host: SSM access plus one-time installer provisioning',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    // Installer provisioning (Greengrass "minimal IAM policy for installer"), narrowed because
    // the group, role, role alias, and thing policy already exist (created by EtpEdge).
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ProvisionCoreThing',
        actions: [
          'iot:CreateThing',
          'iot:AttachThingPrincipal',
          'iot:AddThingToThingGroup',
          'iot:DescribeThing',
        ],
        resources: [
          arn('iot', `thing/${EDGE.coreThingName}`),
          arn('iot', `thinggroup/${EDGE.thingGroup}`),
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadExistingResources',
        actions: [
          'iot:DescribeThingGroup',
          'iot:DescribeRoleAlias',
          'iot:GetPolicy',
          'iot:CreatePolicy',
          'iot:AttachPolicy',
        ],
        resources: [
          arn('iot', `thinggroup/${EDGE.thingGroup}`),
          arn('iot', `rolealias/${EDGE.tesRoleAlias}`),
          arn('iot', `policy/${EDGE.corePolicy}`),
          arn('iot', `policy/GreengrassTESCertificatePolicy${EDGE.tesRoleAlias}`),
          arn('iot', 'cert/*'),
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'NoResourceLevelPermissions',
        // These IoT actions do not support resource-level permissions.
        actions: ['iot:CreateKeysAndCertificate', 'iot:DescribeEndpoint'],
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadTokenExchangeRole',
        actions: ['iam:GetRole', 'iam:PassRole'],
        resources: [`arn:${this.partition}:iam::${this.account}:role/${EDGE.tesRole}`],
      }),
    );

    const nucleusZip = `https://d2s8p88vqu9w66.cloudfront.net/releases/greengrass-${GREENGRASS_VERSIONS.nucleus}.zip`;
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      // Corretto JDK for the nucleus and jarsigner; Docker for the component; iptables for the
      // outage test; chrony keeps the clock right, which device timestamps depend on (ADR 0004).
      'dnf install -y java-21-amazon-corretto-devel docker unzip iptables-nft chrony',
      'systemctl enable --now chronyd docker',
      `curl -sSfL ${nucleusZip} -o /tmp/greengrass.zip`,
      // The nucleus zip is signed by AWS; refuse to install anything that does not verify.
      'jarsigner -verify /tmp/greengrass.zip | grep -q "jar verified."',
      'unzip -q /tmp/greengrass.zip -d /tmp/GreengrassInstaller',
      [
        'java -Droot=/greengrass/v2 -Dlog.store=FILE -jar /tmp/GreengrassInstaller/lib/Greengrass.jar',
        `--aws-region ${this.region}`,
        `--thing-name ${EDGE.coreThingName}`,
        `--thing-group-name ${EDGE.thingGroup}`,
        `--thing-policy-name ${EDGE.corePolicy}`,
        `--tes-role-name ${EDGE.tesRole}`,
        `--tes-role-alias-name ${EDGE.tesRoleAlias}`,
        '--component-default-user ggc_user:ggc_group',
        '--provision true --setup-system-service true',
      ].join(' '),
      // Components run docker as ggc_user; restart so the new group membership applies.
      'usermod -aG docker ggc_user',
      'systemctl restart greengrass',
      'rm -rf /tmp/greengrass.zip /tmp/GreengrassInstaller',
    );

    this.instance = new ec2.Instance(this, 'Core', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup,
      role,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      requireImdsv2: true,
      userData,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(16, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    new CfnOutput(this, 'InstanceId', { value: this.instance.instanceId });
  }
}
