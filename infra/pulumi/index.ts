import * as pulumi from '@pulumi/pulumi';

import { createCorpusBucket } from './src/corpus-bucket';
import { createServiceImage } from './src/ecr';
import { createService } from './src/ecs-service';
import { createTaskRoles } from './src/iam';
import { createKnowledgeBase } from './src/knowledge-base';
import { createLoadBalancer } from './src/load-balancer';
import { resolveNetwork } from './src/network';
import { readStackConfig } from './src/read-config';

const NAME = `lugem-kb-${pulumi.getStack()}`;

const config = readStackConfig();
const network = resolveNetwork(config);

const corpus = createCorpusBucket(NAME);
const knowledgeBase = createKnowledgeBase(NAME, { config, corpusBucketArn: corpus.arn });

const roles = createTaskRoles(NAME, {
  config,
  corpusBucketArn: corpus.arn,
  knowledgeBaseArn: knowledgeBase.knowledgeBaseArn,
});

const image = createServiceImage(NAME);
const loadBalancer = createLoadBalancer(NAME, { config, network });

const service = createService(NAME, {
  config,
  network,
  loadBalancer,
  roles,
  imageUri: image.imageUri,
  corpusBucketName: corpus.name,
  knowledgeBaseId: knowledgeBase.knowledgeBaseId,
});

export const siteUrl = loadBalancer.url;
export const corpusBucketName = corpus.name;
export const knowledgeBaseId = knowledgeBase.knowledgeBaseId;
export const dataSourceId = knowledgeBase.dataSourceId;
export const vectorBucketName = knowledgeBase.vectorBucketName;
export const ecrRepositoryUrl = image.repositoryUrl;
export const clusterName = service.clusterName;
export const serviceName = service.serviceName;
export const logGroupName = service.logGroupName;
