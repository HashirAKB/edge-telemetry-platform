import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { EDGE, GREENGRASS_VERSIONS } from './edge-stack.js';

/**
 * Optional EC2 host for the Greengrass core (FR-EDGE-6, ADR 0014), created only with -c edgeHost=ec2.
 * No inbound ports: operators use SSM Session Manager. Destroy it when not demoing.
 */
export interface EdgeHostStackProps extends StackProps {
  /**
   * Availability zone for the single public subnet. Small instance types can be temporarily out
   * of capacity in one zone (t2.micro in ap-south-1a was, on first deploy), so it is configurable.
   */
  readonly availabilityZone?: string;
}

export class EdgeHostStack extends Stack {
  readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: EdgeHostStackProps = {}) {
    super(scope, id, props);
    const arn = (service: string, resource: string) =>
      `arn:${this.partition}:${service}:${this.region}:${this.account}:${resource}`;

    // One public subnet and no NAT gateway: outbound only, nothing billable when stopped.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ...(props.availabilityZone ? { availabilityZones: [props.availabilityZone] } : { maxAzs: 1 }),
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
      description: 'Greengrass core host: SSM access plus one-time IoT provisioning (no IAM)',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    // Manual provisioning (Greengrass "install with manual resource provisioning"): the host
    // creates its own certificate and joins the group with IoT calls only. The installer's
    // automatic mode was not used because it attaches an extra, broad IAM policy to the token
    // exchange role (found on first deploy; ADR 0014). This role has no IAM permissions at all.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ProvisionCoreThing',
        actions: [
          'iot:CreateThing',
          'iot:AttachThingPrincipal',
          'iot:AddThingToThingGroup',
          'iot:AttachPolicy',
        ],
        // Thing, group, and policy are named; the certificate ID is only known once created.
        resources: [
          arn('iot', `thing/${EDGE.coreThingName}`),
          arn('iot', `thinggroup/${EDGE.thingGroup}`),
          arn('iot', `policy/${EDGE.corePolicy}`),
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

    const nucleusZip = `https://d2s8p88vqu9w66.cloudfront.net/releases/greengrass-${GREENGRASS_VERSIONS.nucleus}.zip`;
    const root = '/greengrass/v2';
    const iotCli = `aws --region ${this.region} iot`;
    // Nucleus configuration for manual provisioning (Greengrass docs); endpoints are filled in
    // on the device by the unquoted here-document below.
    const config = [
      '---',
      'system:',
      `  certificateFilePath: "${root}/device.pem.crt"`,
      `  privateKeyPath: "${root}/private.pem.key"`,
      `  rootCaPath: "${root}/AmazonRootCA1.pem"`,
      `  rootpath: "${root}"`,
      `  thingName: "${EDGE.coreThingName}"`,
      'services:',
      '  aws.greengrass.Nucleus:',
      '    componentType: "NUCLEUS"',
      `    version: "${GREENGRASS_VERSIONS.nucleus}"`,
      '    configuration:',
      `      awsRegion: "${this.region}"`,
      `      iotRoleAlias: "${EDGE.tesRoleAlias}"`,
      '      iotDataEndpoint: "$DATA_EP"',
      '      iotCredEndpoint: "$CRED_EP"',
    ];

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      // 1 GiB of RAM is tight for the nucleus JVM, Docker, and the Node container: add 1 GB swap.
      'fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile',
      "echo '/swapfile none swap sw 0 0' >> /etc/fstab",
      // Corretto JDK for the nucleus and jarsigner; Docker for the component; iptables for the
      // outage test; chrony keeps the clock right, which device timestamps depend on (ADR 0004).
      'dnf install -y java-21-amazon-corretto-devel docker unzip iptables-nft chrony',
      'systemctl enable --now chronyd docker',
      `curl -sSfL ${nucleusZip} -o /tmp/greengrass.zip`,
      // The nucleus zip is signed by AWS; refuse to install anything that does not verify.
      'jarsigner -verify /tmp/greengrass.zip | grep -q "jar verified."',
      'unzip -q /tmp/greengrass.zip -d /tmp/GreengrassInstaller',
      // Identity: the private key is generated by AWS IoT and written straight to the device.
      `mkdir -p ${root} && chmod 755 /greengrass ${root}`,
      `CERT_ARN=$(${iotCli} create-keys-and-certificate --set-as-active --certificate-pem-outfile ${root}/device.pem.crt --public-key-outfile ${root}/public.pem.key --private-key-outfile ${root}/private.pem.key --query certificateArn --output text)`,
      `chmod 600 ${root}/private.pem.key`,
      `${iotCli} create-thing --thing-name ${EDGE.coreThingName} >/dev/null`,
      `${iotCli} attach-thing-principal --thing-name ${EDGE.coreThingName} --principal "$CERT_ARN"`,
      `${iotCli} attach-policy --policy-name ${EDGE.corePolicy} --target "$CERT_ARN"`,
      `${iotCli} add-thing-to-thing-group --thing-name ${EDGE.coreThingName} --thing-group-name ${EDGE.thingGroup}`,
      // Same pinned Amazon Root CA 1 as the simulator image, verified by checksum.
      `curl -sSfL https://www.amazontrust.com/repository/AmazonRootCA1.pem -o ${root}/AmazonRootCA1.pem`,
      `echo "2c43952ee9e000ff2acc4e2ed0897c0a72ad5fa72c3d934e81741cbd54f05bd1  ${root}/AmazonRootCA1.pem" | sha256sum --check --strict`,
      `DATA_EP=$(${iotCli} describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)`,
      `CRED_EP=$(${iotCli} describe-endpoint --endpoint-type iot:CredentialProvider --query endpointAddress --output text)`,
      'cat > /tmp/GreengrassInstaller/config.yaml <<CONFIG',
      ...config,
      'CONFIG',
      [
        `java -Droot=${root} -Dlog.store=FILE -jar /tmp/GreengrassInstaller/lib/Greengrass.jar`,
        '--init-config /tmp/GreengrassInstaller/config.yaml',
        '--component-default-user ggc_user:ggc_group',
        '--setup-system-service true',
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
      // t2.micro (1 vCPU, 1 GiB): the account's on-demand vCPU quota is 1, which rules out
      // t3.small (2 vCPU). Swap plus a capped JVM heap make it fit (ADR 0014).
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      requireImdsv2: true,
      userData,
      // A changed install script means a new host, not a stale one that never re-ran it.
      userDataCausesReplacement: true,
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
