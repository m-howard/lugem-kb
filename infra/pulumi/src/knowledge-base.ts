import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { type StackConfig } from './config';

const VECTOR_INDEX_NAME = 'corpus-index';

export interface KnowledgeBaseArgs {
  readonly config: StackConfig;
  readonly corpusBucketArn: pulumi.Output<string>;
}

export interface KnowledgeBase {
  readonly knowledgeBaseId: pulumi.Output<string>;
  readonly knowledgeBaseArn: pulumi.Output<string>;
  readonly dataSourceId: pulumi.Output<string>;
  readonly vectorBucketName: pulumi.Output<string>;
}

/**
 * Bedrock knowledge base over the markdown corpus, with S3 Vectors as the vector store.
 *
 * S3 Vectors rather than OpenSearch Serverless: an OSS collection bills roughly $700/month with
 * no traffic at all, which makes a demo repository nobody can afford to run. S3 Vectors is
 * pay-per-use. See docs/adr/0005-bedrock-knowledge-base-on-s3-vectors.md.
 *
 * @param name - Resource name prefix.
 * @param args - Stack config and the corpus bucket to ingest from.
 * @returns Identifiers the service and the sync script need.
 */
export function createKnowledgeBase(name: string, args: KnowledgeBaseArgs): KnowledgeBase {
  const { config, corpusBucketArn } = args;

  const vectorBucket = new aws.s3.VectorsVectorBucket(`${name}-vectors`, {
    vectorBucketName: `${name}-vectors`,
  });

  const index = new aws.s3.VectorsIndex(`${name}-vector-index`, {
    vectorBucketName: vectorBucket.vectorBucketName,
    indexName: VECTOR_INDEX_NAME,
    dataType: 'float32',
    // Must match the embedding model exactly; a mismatch fails ingestion rather than degrading.
    dimension: config.embeddingDimensions,
    distanceMetric: 'cosine',
  });

  const role = createServiceRole(name, {
    config,
    corpusBucketArn,
    vectorBucketArn: vectorBucket.vectorBucketArn,
  });

  const embeddingModelArn = pulumi.interpolate`arn:aws:bedrock:${config.region}::foundation-model/${config.embeddingModelId}`;

  const knowledgeBase = new aws.bedrock.AgentKnowledgeBase(
    `${name}-kb`,
    {
      name: `${name}-kb`,
      roleArn: role.arn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: { embeddingModelArn },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: {
          vectorBucketArn: vectorBucket.vectorBucketArn,
          indexName: index.indexName,
        },
      },
    },
    { dependsOn: [index, role] },
  );

  const dataSource = new aws.bedrock.AgentDataSource(`${name}-corpus-source`, {
    name: `${name}-corpus`,
    knowledgeBaseId: knowledgeBase.id,
    dataSourceConfiguration: {
      type: 'S3',
      s3Configuration: {
        bucketArn: corpusBucketArn,
        inclusionPrefixes: [config.corpusPrefix],
      },
    },
  });

  return {
    knowledgeBaseId: knowledgeBase.id,
    knowledgeBaseArn: knowledgeBase.arn,
    dataSourceId: dataSource.dataSourceId,
    vectorBucketName: vectorBucket.vectorBucketName,
  };
}

interface ServiceRoleArgs {
  readonly config: StackConfig;
  readonly corpusBucketArn: pulumi.Output<string>;
  readonly vectorBucketArn: pulumi.Output<string>;
}

/**
 * The role Bedrock assumes to ingest the corpus.
 *
 * Scoped to one bucket, one model and one vector bucket. Bedrock's own documentation offers a
 * wildcard policy; this is the same capability without granting read access to every bucket in
 * the account.
 */
function createServiceRole(name: string, args: ServiceRoleArgs): aws.iam.Role {
  const role = new aws.iam.Role(`${name}-kb-role`, {
    assumeRolePolicy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'bedrock.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
      ],
    }),
  });

  new aws.iam.RolePolicy(`${name}-kb-policy`, {
    role: role.id,
    policy: pulumi
      .all([args.corpusBucketArn, args.vectorBucketArn, args.config.region])
      .apply(([bucketArn, vectorArn, region]) =>
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'ReadCorpus',
              Effect: 'Allow',
              Action: ['s3:GetObject', 's3:ListBucket'],
              Resource: [bucketArn, `${bucketArn}/${args.config.corpusPrefix}*`],
            },
            {
              Sid: 'EmbedWithOneModel',
              Effect: 'Allow',
              Action: ['bedrock:InvokeModel'],
              Resource: [
                `arn:aws:bedrock:${region}::foundation-model/${args.config.embeddingModelId}`,
              ],
            },
            {
              Sid: 'WriteVectorIndex',
              Effect: 'Allow',
              Action: [
                's3vectors:GetIndex',
                's3vectors:ListIndexes',
                's3vectors:PutVectors',
                's3vectors:GetVectors',
                's3vectors:ListVectors',
                's3vectors:DeleteVectors',
                's3vectors:QueryVectors',
              ],
              Resource: [vectorArn, `${vectorArn}/index/*`],
            },
          ],
        }),
      ),
  });

  return role;
}
