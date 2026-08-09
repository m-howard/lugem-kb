import * as awsx from '@pulumi/awsx';
import * as pulumi from '@pulumi/pulumi';

import { reparentedChild } from './child-options';

/** Keeping the last ten images is enough to roll back a bad deploy without paying to store history. */
const UNTAGGED_IMAGE_RETENTION = 10;

/** Build context is the repo root — the Docusaurus content root lives there, not under apps/docs. */
const BUILD_CONTEXT = '../..';
const DOCKERFILE = '../../apps/gateway/Dockerfile';

/**
 * ECR repository plus the built gateway image.
 *
 * The image carries both the API and the built documentation site, because the site is served
 * from ECS rather than a CDN. That is a deliberate coupling — see
 * docs/adr/0003-serve-the-site-from-ecs.md for what it costs.
 *
 * @example
 * ```ts
 * const image = new GatewayImage('lugem-kb-dev', { providers: [awsProvider] });
 * ```
 */
export class GatewayImage extends pulumi.ComponentResource {
  public readonly imageUri: pulumi.Output<string>;
  public readonly repositoryUrl: pulumi.Output<string>;

  constructor(name: string, opts?: pulumi.ComponentResourceOptions) {
    super('lugem:ecr:GatewayImage', name, {}, opts);

    const repository = new awsx.ecr.Repository(
      `${name}-repo`,
      {
        forceDelete: true,
        lifecyclePolicy: {
          rules: [
            {
              tagStatus: 'untagged',
              maximumNumberOfImages: UNTAGGED_IMAGE_RETENTION,
              description: 'Expire untagged images beyond the rollback window',
            },
          ],
        },
      },
      reparentedChild(this),
    );

    const image = new awsx.ecr.Image(
      `${name}-image`,
      {
        repositoryUrl: repository.url,
        context: BUILD_CONTEXT,
        dockerfile: DOCKERFILE,
        platform: 'linux/amd64',
      },
      reparentedChild(this),
    );

    this.imageUri = image.imageUri;
    this.repositoryUrl = repository.url;

    this.registerOutputs({ imageUri: this.imageUri, repositoryUrl: this.repositoryUrl });
  }
}
