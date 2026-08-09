import * as awsx from '@pulumi/awsx';

import type * as pulumi from '@pulumi/pulumi';

/** Keeping the last ten images is enough to roll back a bad deploy without paying to store history. */
const UNTAGGED_IMAGE_RETENTION = 10;

/** Build context is the repo root — the Docusaurus content root lives there, not under apps/docs. */
const BUILD_CONTEXT = '../..';
const DOCKERFILE = '../../apps/gateway/Dockerfile';

export interface ServiceImage {
  readonly imageUri: pulumi.Output<string>;
  readonly repositoryUrl: pulumi.Output<string>;
}

/**
 * ECR repository plus the built gateway image.
 *
 * The image carries both the API and the built documentation site, because the site is served
 * from ECS rather than a CDN. That is a deliberate coupling — see
 * docs/adr/0003-serve-the-site-from-ecs.md for what it costs.
 *
 * @param name - Resource name prefix.
 * @returns The pushed image URI and the repository URL.
 */
export function createServiceImage(name: string): ServiceImage {
  const repository = new awsx.ecr.Repository(`${name}-repo`, {
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
  });

  const image = new awsx.ecr.Image(`${name}-image`, {
    repositoryUrl: repository.url,
    context: BUILD_CONTEXT,
    dockerfile: DOCKERFILE,
    platform: 'linux/amd64',
  });

  return { imageUri: image.imageUri, repositoryUrl: repository.url };
}
