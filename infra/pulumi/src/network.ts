import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { type StackConfig } from './config';

export interface Network {
  readonly vpcId: pulumi.Output<string>;
  readonly privateSubnetIds: readonly string[];
  readonly publicSubnetIds: readonly string[];
}

/**
 * Resolves the existing VPC and asserts the configured subnets actually belong to it.
 *
 * Nothing in this stack creates a VPC — see docs/adr/0006-deploy-into-an-existing-vpc.md. The
 * membership check matters because AWS will happily accept a subnet from another VPC in some
 * calls and reject it in others, and the resulting error surfaces three resources later against
 * something unrelated. Checking here turns that into a preview-time failure naming the subnet.
 *
 * @param config - Validated stack configuration.
 * @param opts - Invoke options, so the lookups run against the same explicit AWS provider — and
 *   therefore the same region — as the resources that consume them.
 * @returns The VPC ID and the subnet lists, once verified.
 */
export function resolveNetwork(config: StackConfig, opts?: pulumi.InvokeOptions): Network {
  const vpc = aws.ec2.getVpcOutput({ id: config.vpcId }, opts);

  const allSubnetIds = [...config.privateSubnetIds, ...config.publicSubnetIds];
  const subnetsInVpc = aws.ec2.getSubnetsOutput(
    {
      filters: [
        { name: 'vpc-id', values: [config.vpcId] },
        { name: 'subnet-id', values: allSubnetIds },
      ],
    },
    opts,
  );

  const verifiedVpcId = pulumi
    .all([vpc.id, subnetsInVpc.ids])
    .apply(([vpcId, foundIds]): string => {
      const missing = allSubnetIds.filter((id) => !foundIds.includes(id));
      if (missing.length > 0) {
        throw new Error(
          `Subnets ${missing.join(', ')} are not in VPC ${vpcId}. Every subnet in ` +
            `privateSubnetIds and publicSubnetIds must belong to the configured vpcId.`,
        );
      }
      return vpcId;
    });

  return {
    vpcId: verifiedVpcId,
    privateSubnetIds: config.privateSubnetIds,
    publicSubnetIds: config.publicSubnetIds,
  };
}
