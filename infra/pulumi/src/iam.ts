import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { type StackConfig } from './config';

export interface TaskRolesArgs {
  readonly config: StackConfig;
  readonly corpusBucketArn: pulumi.Output<string>;
  readonly knowledgeBaseArn: pulumi.Output<string>;
}

export interface TaskRoles {
  readonly executionRole: aws.iam.Role;
  readonly taskRole: aws.iam.Role;
}

const ECS_TASKS_ASSUME_ROLE_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: 'ecs-tasks.amazonaws.com' },
      Action: 'sts:AssumeRole',
    },
  ],
});

/**
 * The two roles an ECS task needs, kept separate on purpose.
 *
 * The execution role is what ECS itself uses to pull the image and write logs. The task role is
 * what the application code gets. Merging them — a common shortcut — would hand the running
 * container the ability to pull and push images, which has nothing to do with serving documents.
 *
 * The task role's grants are the infra half of requirements.md R2 and R5: one bucket, one prefix,
 * one knowledge base ARN. No wildcards.
 *
 * @param name - Resource name prefix.
 * @param args - Stack config and the ARNs the task is allowed to touch.
 * @returns Both roles.
 */
export function createTaskRoles(name: string, args: TaskRolesArgs): TaskRoles {
  const executionRole = new aws.iam.Role(`${name}-execution-role`, {
    assumeRolePolicy: ECS_TASKS_ASSUME_ROLE_POLICY,
  });

  new aws.iam.RolePolicyAttachment(`${name}-execution-role-managed`, {
    role: executionRole.name,
    policyArn: aws.iam.ManagedPolicy.AmazonECSTaskExecutionRolePolicy,
  });

  const taskRole = new aws.iam.Role(`${name}-task-role`, {
    assumeRolePolicy: ECS_TASKS_ASSUME_ROLE_POLICY,
  });

  new aws.iam.RolePolicy(`${name}-task-policy`, {
    role: taskRole.id,
    policy: pulumi
      .all([args.corpusBucketArn, args.knowledgeBaseArn])
      .apply(([bucketArn, knowledgeBaseArn]) =>
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'ListCorpusPrefixOnly',
              Effect: 'Allow',
              Action: ['s3:ListBucket'],
              Resource: [bucketArn],
              Condition: { StringLike: { 's3:prefix': [`${args.config.corpusPrefix}*`] } },
            },
            {
              Sid: 'ReadCorpusPrefixOnly',
              Effect: 'Allow',
              Action: ['s3:GetObject'],
              Resource: [`${bucketArn}/${args.config.corpusPrefix}*`],
            },
            {
              Sid: 'RetrieveFromOneKnowledgeBase',
              Effect: 'Allow',
              Action: ['bedrock:Retrieve'],
              Resource: [knowledgeBaseArn],
            },
          ],
        }),
      ),
  });

  return { executionRole, taskRole };
}
