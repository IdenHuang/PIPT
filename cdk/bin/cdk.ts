#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AmplifyStack } from "../lib/amplify-stack";
import { ApiServiceStack } from "../lib/api-service-stack";
import { DatabaseStack } from "../lib/database-stack";
import { DBFlowStack } from "../lib/dbFlow-stack";
import { VpcStack } from "../lib/vpc-stack";
import {
  EcsSocketStack,
  getSocketEcsClusterSsmParam,
  getSocketEcsServiceSsmParam,
} from "../lib/ecs-socket-stack";
import { TurnServerStack } from "../lib/turn-server-stack";
import { CICDStack } from "../lib/cicd-stack";
import { CloudFrontWafStack } from "../lib/cloudfront-waf-stack";
import { AuditTrailStack } from "../lib/audit-trail-stack";

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const StackPrefix = app.node.tryGetContext("StackPrefix");
const githubRepo = app.node.tryGetContext("githubRepo");
const sesVerifiedDomain = app.node.tryGetContext("SesVerifiedDomain") || "";

// CI/CD pipeline — creates ECR repos, CodeBuild projects, and CodePipeline
const cicdStack = new CICDStack(app, `${StackPrefix}-CICD`, {
  env,
  githubRepo,
  githubBranch: app.node.tryGetContext("githubBranch") || "main",
  stackPrefix: StackPrefix,
  lambdaFunctions: [
    {
      name: "textGeneration",
      functionName: `${StackPrefix}-Api-TextGenLambdaDockerFunction`,
      sourceDir: "cdk/text_generation",
    },
    {
      name: "dataIngestion",
      functionName: `${StackPrefix}-Api-DataIngestLambdaDockerFunction`,
      sourceDir: "cdk/data_ingestion",
    },
    {
      name: "socketServer",
      sourceDir: "cdk/socket-server",
      ecsServiceSsmParams: {
        cluster: getSocketEcsClusterSsmParam(StackPrefix),
        service: getSocketEcsServiceSsmParam(StackPrefix),
      },
    },
    {
      // Hosted on Bedrock AgentCore (configured outside CDK); the build only
      // pushes and records the approved image tag.
      name: "voiceAgent",
      sourceDir: "cdk/voice-agent",
    },
  ],
});

const vpcStack = new VpcStack(app, `${StackPrefix}-VpcStack`, {
  env,
  terminationProtection: true,
});
const dbStack = new DatabaseStack(app, `${StackPrefix}-Database`, vpcStack, {
  env,
  // Reject stack deletion outright; RDS deletionProtection only guards the instance,
  // not the proxy, IAM role, or app credential secrets in this stack.
  terminationProtection: true,
});

// CloudFront WAF must be in us-east-1 (AWS requirement for CLOUDFRONT scope)
const cloudFrontWafStack = new CloudFrontWafStack(
  app,
  `${StackPrefix}-CloudFrontWaf`,
  {
    env: { account: env.account, region: "us-east-1" },
    crossRegionReferences: true,
  }
);

const apiStack = new ApiServiceStack(
  app,
  `${StackPrefix}-Api`,
  dbStack,
  vpcStack,
  null, // ecsSocketStack will be passed later
  cicdStack.ecrRepositories["textGeneration"],
  cicdStack.ecrRepositories["dataIngestion"],
  cicdStack.buildProjects["textGeneration"]?.projectName,
  cicdStack.buildProjects["dataIngestion"]?.projectName,
  cloudFrontWafStack.webAclArn,
  sesVerifiedDomain || undefined,
  { env, crossRegionReferences: true }
);
const turnServerStack = new TurnServerStack(
  app,
  `${StackPrefix}-TurnServer`,
  vpcStack,
  { env }
);

// Voice agent is hosted on Bedrock AgentCore — pass the runtime ARN
// to the socket-server so it can connect via SigV4-signed WebSocket.
// Priority: 1) -c voiceAgentArn="..." context override  2) SSM parameter /{StackPrefix}/voiceAgentArn
const voiceAgentArn = app.node.tryGetContext("voiceAgentArn") || "";

const ecsSocketStack = new EcsSocketStack(
  app,
  `${StackPrefix}-EcsSocket`,
  vpcStack,
  dbStack,
  apiStack,
  cicdStack.ecrRepositories["socketServer"],
  turnServerStack,
  voiceAgentArn,
  StackPrefix,
  apiStack.getDynamoTableName(),
  cloudFrontWafStack.webAclArn,
  { env, crossRegionReferences: true },
  cicdStack.buildRoles["socketServer"]
);
const dbFlowStack = new DBFlowStack(
  app,
  `${StackPrefix}-DBFlow`,
  vpcStack,
  dbStack,
  apiStack,
  { env }
);

const amplifyStack = new AmplifyStack(
  app,
  `${StackPrefix}-Amplify`,
  apiStack,
  {
    env,
  }
);
// Amplify reads the socket URL from SSM written by EcsSocket.
// addDependency ensures EcsSocket deploys first (creates the param)
// without creating a cross-stack CloudFormation export.
amplifyStack.addDependency(ecsSocketStack);
// Tag all resources for cost allocation.
// EcsSocket stack excluded entirely — AWS::CloudFront::VpcOrigin cannot be
// updated (even tag changes) while attached to a distribution. Any resource
// change in that stack triggers a cascading VpcOrigin update that fails.
// ECS/CloudFront costs are still trackable via AWS billing dimensions.
cdk.Tags.of(cicdStack).add("Project", StackPrefix);
cdk.Tags.of(vpcStack).add("Project", StackPrefix);
cdk.Tags.of(dbStack).add("Project", StackPrefix);
cdk.Tags.of(cloudFrontWafStack).add("Project", StackPrefix);
cdk.Tags.of(apiStack).add("Project", StackPrefix);
cdk.Tags.of(turnServerStack).add("Project", StackPrefix);
cdk.Tags.of(dbFlowStack).add("Project", StackPrefix);
cdk.Tags.of(amplifyStack).add("Project", StackPrefix);

// Optional CloudTrail trail. Off by default because most accounts already have
// an organization or Control Tower trail, and a second copy is billed.
// Enable with: cdk deploy -c EnableCloudTrail=true
if (String(app.node.tryGetContext("EnableCloudTrail")) === "true") {
  const auditTrailStack = new AuditTrailStack(app, `${StackPrefix}-AuditTrail`, { env });
  cdk.Tags.of(auditTrailStack).add("Project", StackPrefix);
}
