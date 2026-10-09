/**
 * Builds the simulator image for the EC2 core (linux/amd64), tags it with the git short SHA, and
 * pushes it to the private ECR repository created by EtpFoundation. Tags are immutable, so an
 * existing tag is never overwritten.
 *
 *   AWS_PROFILE=etp pnpm edge:publish-image
 */
import { spawnSync } from 'node:child_process';
import {
  DescribeImagesCommand,
  ECRClient,
  GetAuthorizationTokenCommand,
} from '@aws-sdk/client-ecr';
import { awsContext, fail, REPO_ROOT } from './lib/context.js';

const REPOSITORY = 'etp/simulator';
const SOURCES = ['packages/simulator', 'packages/shared', 'pnpm-lock.yaml', 'package.json'];

function run(command: string, args: string[], input?: string): string {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    input,
    encoding: 'utf8',
    stdio: input === undefined ? ['ignore', 'pipe', 'inherit'] : ['pipe', 'pipe', 'inherit'],
  });
  if (result.status !== 0)
    fail(`${command} ${args[0] ?? ''} failed (exit ${String(result.status)})`);
  return result.stdout.trim();
}

const { region, account } = await awsContext();
const sha = run('git', ['rev-parse', '--short', 'HEAD']);
// Uncommitted changes to the image sources get a unique tag, so the SHA tag always means
// "built from that commit".
const dirty = run('git', ['status', '--porcelain', '--', ...SOURCES]) !== '';
const tag = dirty ? `${sha}-dirty-${String(Math.floor(Date.now() / 1000))}` : sha;
const registry = `${account}.dkr.ecr.${region}.amazonaws.com`;
const image = `${registry}/${REPOSITORY}:${tag}`;

const ecr = new ECRClient({ region });
try {
  await ecr.send(
    new DescribeImagesCommand({ repositoryName: REPOSITORY, imageIds: [{ imageTag: tag }] }),
  );
  console.log(`${image} already exists; nothing to push.`);
} catch (error) {
  if (!(error instanceof Error && error.name === 'ImageNotFoundException')) throw error;

  console.log(`building ${image} for linux/amd64`);
  run('docker', [
    'build',
    '--platform',
    'linux/amd64',
    '-f',
    'packages/simulator/Dockerfile',
    '-t',
    image,
    '.',
  ]);

  const auth = await ecr.send(new GetAuthorizationTokenCommand({}));
  const token = auth.authorizationData?.[0]?.authorizationToken ?? fail('no ECR token');
  const password = Buffer.from(token, 'base64').toString('utf8').split(':')[1] ?? '';
  // The password goes to docker on stdin and is never printed or written to disk by us.
  run('docker', ['login', '--username', 'AWS', '--password-stdin', registry], password);
  run('docker', ['push', image]);
  run('docker', ['logout', registry]);
  console.log(`pushed ${image}`);
}

console.log(`\nDeploy the component with:
  pnpm -F @etp/infra exec cdk deploy EtpEdge --exclusively --profile <profile> -c simulatorImageTag=${tag}`);
