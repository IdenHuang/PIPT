import { Stack, StackProps, CfnOutput, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { VpcStack } from "./vpc-stack";
import { DatabaseStack } from "./database-stack";
import { TurnServerStack } from "./turn-server-stack";
import { LogProtection } from "./log-protection";
import { approvedImageTag } from "./approved-image";

/** SSM parameter name where the socket URL is published for other stacks to read. */
export const getSocketUrlSsmParam = (stackPrefix: string) => `/${stackPrefix}/socket-url`;

/**
 * SSM parameter name holding the VPC-internal base URL the text-generation
 * Lambda POSTs streaming chunks to (`{url}/stream-callback`). The Lambda reads
 * this at runtime instead of accepting a caller-supplied URL, so the
 * x-callback-token secret is only ever sent to the socket server's NLB.
 */
export const getSocketCallbackUrlSsmParam = (stackPrefix: string) =>
  `/${stackPrefix}/socket-callback-url`;

/**
 * SSM parameter names holding the exact socket ECS cluster and service names.
 * The CI/CD build reads them to redeploy that one service after pushing a new
 * image; its UpdateService permission is scoped to the same service ARN.
 */
export const getSocketEcsClusterSsmParam = (stackPrefix: string) =>
  `/${stackPrefix}/socket-ecs-cluster`;
export const getSocketEcsServiceSsmParam = (stackPrefix: string) =>
  `/${stackPrefix}/socket-ecs-service`;

export class EcsSocketStack extends Stack {
  public readonly socketUrl: string;

  constructor(
    scope: Construct,
    id: string,
    vpcStack: VpcStack,
    db: DatabaseStack,
    apiServiceStack: any,
    socketServerRepo: ecr.IRepository,
    turnServerStack: TurnServerStack,
    voiceAgentEndpoint: string | undefined,
    stackPrefix: string,
    dynamoTableName: string,
    cloudFrontWafArn: string,
    props?: StackProps,
    // The socketServer CI/CD build role, allowed to redeploy this service.
    deployRole?: iam.IRole
  ) {
    super(scope, id, props);

    // Resolve voice agent ARN: use explicit value if provided, otherwise read from SSM
    const resolvedVoiceAgentEndpoint = voiceAgentEndpoint ||
      ssm.StringParameter.valueForStringParameter(this, `/${stackPrefix}/voiceAgentArn`);

    const vpc = vpcStack.vpc;

    // 1) ECS cluster
    const cluster = new ecs.Cluster(this, "SocketCluster", { vpc });

    // 2) Task role
    const taskRole = new iam.Role(this, "SocketTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
      inlinePolicies: {
        BedrockPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "bedrock:InvokeModel",
                "bedrock:InvokeModelWithBidirectionalStream",
                "bedrock:Converse",
                "bedrock:ConverseStream",
                "bedrock:InvokeModelWithResponseStream",
                "bedrock:ApplyGuardrail",
              ],
              // Scoped to specific models instead of "*" so leaked task credentials
              // can't invoke arbitrary models in the account.
              resources: [
                // Same models/inference profiles as the textGen Lambda role
                // (cdk/lib/api-service-stack.ts, bedrockPolicyStatement).
                "arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-sonnet-4-6",
                "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6",
                `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
                "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0",
                "arn:aws:bedrock:us-east-1::foundation-model/cohere.embed-v4:0",
                // PIPT guardrail (Api stack deploys to the same region as this stack).
                `arn:aws:bedrock:${this.region}:${this.account}:guardrail/*`,
                // Models the socket server calls directly. Keep in sync with the
                // model IDs and regions in cdk/socket-server/nova_sonic.py and
                // cdk/socket-server/voice_preview_tts.py.
                "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-sonic-v1:0",
                "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-2-sonic-v1:0",
                `arn:aws:bedrock:${this.region}::foundation-model/amazon.nova-lite-v1:0`,
                // us-east-1 fallback used by the diagnosis check in nova_sonic.py
                "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0",
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "bedrock-agentcore:InvokeAgentRuntime",
                "bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream",
              ],
              resources: ["*"],
            }),
            // No sts:AssumeRole here: the socket server never assumes another role,
            // and an unscoped AssumeRole would let it pivot into any role that trusts
            // this account (and read secrets through it). sts:GetCallerIdentity
            // needs no IAM permission.
          ],
        }),
      },
    });

    // DynamoDB permissions for ECS task role
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
        ],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/${dynamoTableName}`,
        ],
      })
    );

    // Add VPC endpoint permissions for private subnet access
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
        ],
        resources: ["*"],
      })
    );

    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          db.secretPathUser.secretArn,
          apiServiceStack.secret.secretArn,
          apiServiceStack.streamCallbackSecret.secretArn,
        ],
      })
    );

    // Grant ECS task role permission to read the TURN shared secret
    turnServerStack.turnSecret.grantRead(taskRole);

    // REVIEW: The task role is also used as the execution role. These should be separate:
    // - Task role: permissions the application code needs at runtime (Bedrock, DynamoDB, etc.)
    // - Execution role: permissions ECS needs to pull images and write logs
    // Sharing them means the ECS agent has access to Bedrock, DynamoDB, etc., which violates least privilege.
    const taskDef = new ecs.FargateTaskDefinition(this, "SocketTaskDef", {
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole,
      executionRole: taskRole, // ← should be a separate, minimal execution role
    });

    // 3) Network Load Balancer on TCP 80
    // CloudFront VPC Origin requires the NLB to have a security group.
    const nlbSg = new ec2.SecurityGroup(this, "SocketNLBSG", {
      vpc,
      allowAllOutbound: true,
    });
    // Only CloudFront (origin-facing prefix list, as the VPC origins docs
    // recommend) and in-VPC callers (the text-gen Lambda's /stream-callback
    // POSTs) may reach the NLB; not 0.0.0.0/0.
    // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html
    const cloudFrontOriginFacing = ec2.PrefixList.fromLookup(this, "CloudFrontOriginFacing", {
      prefixListName: "com.amazonaws.global.cloudfront.origin-facing",
    });
    nlbSg.addIngressRule(
      ec2.Peer.prefixList(cloudFrontOriginFacing.prefixListId),
      ec2.Port.tcp(80),
      "CloudFront VPC Origin inbound"
    );
    nlbSg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(80),
      "In-VPC stream callbacks (text-gen Lambda)"
    );

    const nlb = new elbv2.NetworkLoadBalancer(this, "SocketNLBInternal", {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [nlbSg],
      // The service runs a single task, so most AZs have no local target.
      // Without cross-zone, connections that DNS sends to those AZs' NLB
      // nodes hang until the client's connect timeout (~5s per streamed
      // chunk from the text-gen Lambda).
      crossZoneEnabled: true,
    });

    // Finite retention + CMK for the socket task's log group.
    const logProtection = new LogProtection(this, "SocketLogProtection");

    // 4) Container listening on port 80
    const socketContainer = taskDef.addContainer("SocketContainer", {
      // Pinned to the newest scan-approved image (an immutable tag), not :latest.
      image: ecs.ContainerImage.fromEcrRepository(
        socketServerRepo,
        approvedImageTag(this, "SocketImageWaiter", {
          serviceToken: apiServiceStack.imageWaiterServiceToken,
          repository: socketServerRepo,
          stackPrefix,
          moduleName: "socketServer",
        })
      ),
      portMappings: [{ containerPort: 80 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "Socket",
        logRetention: logProtection.retention,
      }),
      environment: {
        NODE_ENV: "production",
        SM_DB_CREDENTIALS: db.secretPathUser.secretName,
        SM_COGNITO_CREDENTIALS: apiServiceStack.secret.secretName,
        RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        AWS_REGION: this.region,
        AWS_DEFAULT_REGION: this.region,
        COGNITO_USER_POOL_ID: apiServiceStack.getUserPoolId(),
        COGNITO_CLIENT_ID: apiServiceStack.getUserPoolClientId(),
        TEXT_GENERATION_ENDPOINT: apiServiceStack.getEndpointUrl(),
        APPSYNC_GRAPHQL_URL: apiServiceStack.appSyncApi.graphqlUrl,
        SOCKET_EXECUTION_ROLE_ARN: taskRole.roleArn,
        TURN_SERVER_URL: turnServerStack.turnServerUrl,
        STUN_SERVER_URL: turnServerStack.stunServerUrl,
        BEDROCK_GUARDRAIL_ID: apiServiceStack.getGuardrailId(),
        // Guardrail IDs are regional; the guardrail lives in the Api stack's region.
        BEDROCK_GUARDRAIL_REGION: apiServiceStack.region,
        TABLE_NAME: dynamoTableName,
        SM_STREAM_CALLBACK_SECRET: apiServiceStack.streamCallbackSecret.secretName,
        ALLOWED_ORIGINS: apiServiceStack.getAllowedOriginsEnv(),
        ...(resolvedVoiceAgentEndpoint ? { VOICE_AGENT_ENDPOINT: resolvedVoiceAgentEndpoint } : {}),
      },
      secrets: {
        TURN_SHARED_SECRET: ecs.Secret.fromSecretsManager(turnServerStack.turnSecret),
      },
    });

    // The awslogs driver creates its log group at <container>/LogGroup. Encrypt
    // that existing group in place rather than passing a new `logGroup`, which
    // would orphan the old group (and the data already in it) with infinite
    // retention.
    const socketLogGroup = socketContainer.node.findChild("LogGroup") as logs.LogGroup;
    (socketLogGroup.node.defaultChild as logs.CfnLogGroup).kmsKeyId =
      logProtection.encryptionKey.keyArn;

    const socketServiceSg = new ec2.SecurityGroup(this, "SocketServiceSG", {
      vpc,
      description: "Security group for ECS socket service",
      allowAllOutbound: true,
    });
    const importedDbSg = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      `${id}-imported-db-sg`,
      db.dbSecurityGroup.securityGroupId
    );
    importedDbSg.addIngressRule(
      socketServiceSg,
      ec2.Port.tcp(5432),
      "Allow ECS socket service to access RDS Proxy"
    );

    const service = new ecs.FargateService(this, "SocketService", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1, // Single task — textStreamSockets map is in-memory, requires all traffic on one container
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [socketServiceSg],
      circuitBreaker: { enable: true, rollback: true },
    });

    // 5.0) Let the CI/CD build roll exactly this service onto a task
    // definition revision pinned to the new image's digest
    // (cdk/scripts/deploy_image.sh).
    const ecsClusterParam = new ssm.StringParameter(this, "SocketEcsClusterParam", {
      parameterName: getSocketEcsClusterSsmParam(stackPrefix),
      stringValue: cluster.clusterName,
      description: "Socket server ECS cluster name, for CI/CD redeploys",
    });
    const ecsServiceParam = new ssm.StringParameter(this, "SocketEcsServiceParam", {
      parameterName: getSocketEcsServiceSsmParam(stackPrefix),
      stringValue: service.serviceName,
      description: "Socket server ECS service name, for CI/CD redeploys",
    });
    if (deployRole) {
      new iam.Policy(this, "SocketRedeployPolicy", {
        roles: [deployRole],
        statements: [
          new iam.PolicyStatement({
            actions: ["ecs:UpdateService", "ecs:DescribeServices"],
            resources: [service.serviceArn],
          }),
          // ECS doesn't support resource-level permissions for these two
          // actions. A registered revision can't run anywhere except through
          // the UpdateService grant above, and PassRole below limits it to
          // this service's own roles.
          // https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonelasticcontainerservice.html
          new iam.PolicyStatement({
            actions: ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"],
            resources: ["*"],
          }),
          new iam.PolicyStatement({
            actions: ["iam:PassRole"],
            resources: [taskRole.roleArn],
            conditions: {
              StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
            },
          }),
          new iam.PolicyStatement({
            actions: ["ssm:GetParameter"],
            resources: [ecsClusterParam.parameterArn, ecsServiceParam.parameterArn],
          }),
        ],
      });
    }

    // 5.1) Allow the internal NLB to reach the service on port 80 (VPC traffic only)
    service.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(80),
      "Allow NLB to reach ECS service"
    );



    // 6) NLB listener and target group
    // REVIEW: The NLB listener is on port 80 (unencrypted). WebSocket traffic from CloudFront
    // arrives over HTTP. While CloudFront enforces HTTPS on the viewer side (REDIRECT_TO_HTTPS),
    // the origin connection is HTTP_ONLY. Consider adding a TLS listener (port 443) with an
    // ACM certificate for end-to-end encryption.
    const listener = nlb.addListener("TcpListener", {
      port: 80,
      protocol: elbv2.Protocol.TCP,
    });
    listener.addTargets("EcsTargetGroupV2", {
      protocol: elbv2.Protocol.TCP,
      port: 80,
      targets: [service],
      healthCheck: {
        protocol: elbv2.Protocol.TCP,
        port: "80",
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
      },
    });

    // 6.1) Publish the VPC-internal callback URL for the text-generation Lambda.
    // The Lambda runs in the same VPC and reaches the internal NLB directly,
    // so /stream-callback traffic never needs to traverse CloudFront.
    new ssm.StringParameter(this, "SocketCallbackUrlParam", {
      parameterName: getSocketCallbackUrlSsmParam(stackPrefix),
      stringValue: `http://${nlb.loadBalancerDnsName}`,
      description: "VPC-internal socket server URL for text-gen Lambda stream callbacks",
    });

    // 7) CloudFront distribution in front of the NLB
    // Block internal-only routes at the edge. /stream-callback is meant to be
    // called only by the text-gen Lambda from inside the VPC; exposing it via
    // CloudFront lets anyone holding the callback token inject stream events.
    // The URI is decoded, lowercased and slash-collapsed first because Express
    // routes case-insensitively and tolerates trailing slashes.
    const blockInternalRoutesFn = new cloudfront.Function(this, "BlockInternalRoutesFn", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: "Return 403 for internal-only socket server routes",
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var uri = event.request.uri;
  try { uri = decodeURIComponent(uri); } catch (e) { /* malformed encoding: inspect raw URI */ }
  uri = uri.toLowerCase().replace(/\\/{2,}/g, "/");
  if (uri.indexOf("/stream-callback") !== -1) {
    return { statusCode: 403, statusDescription: "Forbidden" };
  }
  return event.request;
}
`),
    });

    const distro = new cloudfront.Distribution(this, "SocketDistro", {
      defaultBehavior: {
        origin: origins.VpcOrigin.withNetworkLoadBalancer(nlb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          readTimeout: Duration.seconds(60),
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            function: blockInternalRoutesFn,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      webAclId: cloudFrontWafArn,
    });

    // 8) Output CloudFront URL
    this.socketUrl = `wss://${distro.domainName}`;

    // Publish to SSM so other stacks can read without a cross-stack export dependency.
    new ssm.StringParameter(this, "SocketUrlParam", {
      parameterName: getSocketUrlSsmParam(stackPrefix),
      stringValue: this.socketUrl,
      description: "WebSocket server URL via CloudFront + NLB",
    });

    new CfnOutput(this, "SocketUrl", {
      value: this.socketUrl,
      description: "WebSocket server URL via CloudFront + NLB",
    });

    // TEMPORARY: Keep the old cross-stack export alive until Amplify's deployed
    // template no longer references it. After a successful --all deploy, remove this.
    new CfnOutput(this, "ExportsOutputFnGetAttSocketDistro6CB9A510DomainName3741F4F7", {
      value: distro.domainName,
      exportName: `${Stack.of(this).stackName}:ExportsOutputFnGetAttSocketDistro6CB9A510DomainName3741F4F7`,
    });
    
  }
}
