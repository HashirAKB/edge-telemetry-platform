import { join } from 'node:path';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

export const REPO_ROOT = join(import.meta.dirname, '..', '..');
export const CERTS_DIR = join(REPO_ROOT, '.certs');

export const DEV_THING_NAME = 'etp-dev-device';
export const DEV_POLICY_NAME = 'etp-dev-device-policy';

export const devDevicePaths = {
  certificate: join(CERTS_DIR, `${DEV_THING_NAME}.cert.pem`),
  privateKey: join(CERTS_DIR, `${DEV_THING_NAME}.private.key`),
  state: join(CERTS_DIR, `${DEV_THING_NAME}.json`),
  env: join(CERTS_DIR, `${DEV_THING_NAME}.env`),
};

export interface AwsContext {
  readonly region: string;
  readonly account: string;
  readonly arn: string;
}

/**
 * Every script needs an explicit AWS_PROFILE, so it can never fall back to whatever default
 * credentials happen to be on the machine, and it prints the account before doing anything.
 */
export async function awsContext(): Promise<AwsContext> {
  const profile = process.env.AWS_PROFILE;
  if (!profile) {
    fail('Set AWS_PROFILE explicitly, for example: AWS_PROFILE=etp pnpm <script>');
  }
  const region = process.env.AWS_REGION ?? 'ap-south-1';
  const identity = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
  if (!identity.Account || !identity.Arn) fail('Could not resolve the AWS identity');
  console.log(`AWS profile ${profile}, account ${identity.Account}, region ${region}`);
  return { region, account: identity.Account, arn: identity.Arn };
}

export function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

export function isAwsError(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}
