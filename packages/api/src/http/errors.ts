import type { z } from 'zod';

/** Errors that map to a specific RFC 7807 response; anything else becomes a 500. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly errors?: readonly { path: string; message: string }[],
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
  }
}

export const notFound = (detail: string) => new ApiError(404, 'Not Found', detail);
export const badRequest = (detail: string) => new ApiError(400, 'Bad Request', detail);

/** Validate input with a shared schema; a failure becomes 400 with one entry per issue. */
export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  input: unknown,
  what: string,
): z.infer<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ApiError(
    400,
    'Bad Request',
    `Invalid ${what}`,
    result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || what,
      message: issue.message,
    })),
  );
}
