import * as pulumi from '@pulumi/pulumi';

import { type StackConfig, validateStackConfig } from './config';

/**
 * Reads and validates stack configuration from the Pulumi engine.
 *
 * The thin half of the config module: everything that can be decided without a Pulumi runtime
 * lives in {@link validateStackConfig}, which is why this file has no tests and needs none.
 *
 * @returns Validated stack configuration.
 * @throws {import('./config').StackConfigError} When configuration is unusable.
 */
export function readStackConfig(): StackConfig {
  const config = new pulumi.Config();
  const aws = new pulumi.Config('aws');

  return validateStackConfig({
    region: aws.get('region'),
    vpcId: config.get('vpcId'),
    privateSubnetIds: config.getObject<string[]>('privateSubnetIds'),
    publicSubnetIds: config.getObject<string[]>('publicSubnetIds'),
    albScheme: config.get('albScheme'),
    certificateArn: config.get('certificateArn'),
    desiredCount: config.getNumber('desiredCount'),
    cpu: config.getNumber('cpu'),
    memory: config.getNumber('memory'),
    logRetentionDays: config.getNumber('logRetentionDays'),
    embeddingModelId: config.get('embeddingModelId'),
    corpusPrefix: config.get('corpusPrefix'),
    containerPort: config.getNumber('containerPort'),
    allowUnverifiedRegion: config.getBoolean('allowUnverifiedRegion'),
  });
}
