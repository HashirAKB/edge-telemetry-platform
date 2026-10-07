import { Stack } from 'aws-cdk-lib';

/**
 * Shared foundation resources (ECR repository, SNS alerts topic, rule-errors log group).
 * Empty until Phase 4; it exists now so CI can run `cdk synth` from day one.
 */
export class FoundationStack extends Stack {}
