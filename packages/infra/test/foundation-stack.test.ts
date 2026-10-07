import { App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { FoundationStack } from '../src/stacks/foundation-stack.js';
import { PROJECT_TAGS } from '../src/tags.js';

describe('FoundationStack', () => {
  it('synthesizes without AWS credentials and carries the project tags', () => {
    const app = new App();
    new FoundationStack(app, 'TestFoundation', { tags: { ...PROJECT_TAGS } });

    // Stack tags land in the cloud assembly; CloudFormation applies them to every resource.
    const artifact = app.synth().getStackByName('TestFoundation');
    expect(artifact.tags).toEqual(PROJECT_TAGS);
  });
});
