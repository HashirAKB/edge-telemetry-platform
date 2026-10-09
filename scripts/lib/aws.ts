import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { GetCommandInvocationCommand, SendCommandCommand, SSMClient } from '@aws-sdk/client-ssm';
import { fail } from './context.js';

export async function stackOutputs(
  region: string,
  stackName: string,
): Promise<Record<string, string>> {
  try {
    const out = await new CloudFormationClient({ region }).send(
      new DescribeStacksCommand({ StackName: stackName }),
    );
    return Object.fromEntries(
      (out.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']),
    );
  } catch {
    return fail(`stack ${stackName} not found; is it deployed?`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a shell script as root on an instance through SSM Run Command (no inbound ports needed)
 * and wait for it to finish. Returns stdout; throws with stderr when the script fails.
 */
export async function runOnInstance(
  region: string,
  instanceId: string,
  script: string,
  timeoutSeconds = 600,
): Promise<string> {
  const ssm = new SSMClient({ region });
  const sent = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: 'AWS-RunShellScript',
      Parameters: { commands: [script], executionTimeout: [String(timeoutSeconds)] },
      TimeoutSeconds: 60,
    }),
  );
  const commandId = sent.Command?.CommandId ?? fail('SSM did not return a command ID');
  const deadline = Date.now() + (timeoutSeconds + 60) * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      const inv = await ssm.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }),
      );
      if (inv.Status === 'Success') return inv.StandardOutputContent ?? '';
      if (['Failed', 'Cancelled', 'TimedOut'].includes(inv.Status ?? '')) {
        throw new Error(`SSM command ${inv.Status ?? ''}: ${inv.StandardErrorContent ?? ''}`);
      }
    } catch (error) {
      // The invocation can take a moment to register after SendCommand.
      if (!(error instanceof Error && error.name === 'InvocationDoesNotExist')) throw error;
    }
  }
  throw new Error(`SSM command ${commandId} did not finish within ${String(timeoutSeconds)} s`);
}
