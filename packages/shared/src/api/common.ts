import { z } from 'zod';

/** SiteWise asset and property IDs are UUIDs. */
export const AssetId = z.uuid().meta({ description: 'SiteWise asset ID' });
export const PropertyId = z.uuid().meta({ description: 'SiteWise asset property ID' });

/** ISO-8601 timestamp with an explicit offset, e.g. `2026-10-07T10:15:00Z`. */
export const IsoTimestamp = z.iso.datetime({ offset: true });

export const Quality = z.enum(['GOOD', 'BAD', 'UNCERTAIN']);
export type Quality = z.infer<typeof Quality>;

export const PropertyValue = z.union([z.number(), z.string(), z.boolean()]);

/** RFC 7807 problem details, served as `application/problem+json`. */
export const Problem = z
  .object({
    type: z.string().default('about:blank'),
    title: z.string(),
    status: z.int().min(400).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
    /** Field-level validation errors (extension member). */
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .meta({ id: 'Problem' });
export type Problem = z.infer<typeof Problem>;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
