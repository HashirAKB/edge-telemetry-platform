import { PLATFORM_NAME } from '@etp/shared';

/**
 * Tags for every stack (SRS section 10). With the `@aws-cdk/core:explicitStackTags` flag on,
 * `Tags.of(app)` is ignored, so these are passed as stack props and CloudFormation
 * propagates them to every resource in the stack.
 */
export const PROJECT_TAGS: Readonly<Record<string, string>> = {
  project: PLATFORM_NAME,
  owner: 'hashir',
};
