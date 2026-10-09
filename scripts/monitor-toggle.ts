/**
 * Turns the freshness monitor on or off (docs/cost.md: the platform runs on demand, so the
 * monitor runs only around demos and stale alarms stay quiet otherwise).
 *
 *   AWS_PROFILE=etp pnpm monitor:on
 *   AWS_PROFILE=etp pnpm monitor:off
 *
 * CDK deploys the schedule disabled; this changes only its state. The next deploy that touches
 * the schedule resets it to the CDK value.
 */
import {
  GetScheduleCommand,
  SchedulerClient,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';
import { awsContext, fail } from './lib/context.js';

const NAME = 'etp-freshness-monitor';
const state = process.argv.includes('on')
  ? 'ENABLED'
  : process.argv.includes('off')
    ? 'DISABLED'
    : undefined;
if (!state) fail('usage: monitor-toggle.ts on|off');

const { region } = await awsContext();
const client = new SchedulerClient({ region });
const current = await client.send(new GetScheduleCommand({ Name: NAME }));
if (!current.ScheduleExpression || !current.Target || !current.FlexibleTimeWindow) {
  fail(`schedule ${NAME} is incomplete; redeploy EtpObservability`);
}
// UpdateSchedule replaces the whole definition, so send everything back with only State changed.
await client.send(
  new UpdateScheduleCommand({
    Name: NAME,
    GroupName: current.GroupName,
    Description: current.Description,
    ScheduleExpression: current.ScheduleExpression,
    ScheduleExpressionTimezone: current.ScheduleExpressionTimezone,
    FlexibleTimeWindow: current.FlexibleTimeWindow,
    Target: current.Target,
    State: state,
  }),
);
console.log(`${NAME}: ${current.State ?? '?'} -> ${state}`);
