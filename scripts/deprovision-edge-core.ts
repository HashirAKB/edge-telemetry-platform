/**
 * Removes what the Greengrass installer created outside CloudFormation (the core device, its
 * AWS IoT thing and certificate, and the installer's TES certificate policy). Run after
 * destroying EtpEdgeHost and before destroying EtpEdge. Safe to re-run. pnpm teardown runs the
 * same steps.
 *
 *   AWS_PROFILE=etp pnpm edge:deprovision
 */
import { awsContext } from './lib/context.js';
import { deprovisionEdgeCore } from './lib/edge-core.js';

const { region } = await awsContext();
await deprovisionEdgeCore(region);
