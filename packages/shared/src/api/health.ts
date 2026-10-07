import { z } from 'zod';
import { IsoTimestamp } from './common.js';

/** FR-API-7: unauthenticated, cheap liveness plus a SiteWise reachability check. */
export const HealthResponse = z
  .object({
    status: z.enum(['ok', 'degraded']),
    version: z.string(),
    sitewise: z.enum(['reachable', 'unreachable']),
    checkedAt: IsoTimestamp,
  })
  .meta({ id: 'HealthResponse' });
export type HealthResponse = z.infer<typeof HealthResponse>;
