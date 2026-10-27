import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";

/**
 * SSM parameter holding the tag of the newest image of `moduleName` that passed
 * the vulnerability gate. The build writes it; CDK consumers (Lambda, ECS) pin
 * to the tag it holds, so a CDK deploy never rolls back what the build shipped.
 */
export const getImageTagSsmParam = (stackPrefix: string, moduleName: string) =>
  `/${stackPrefix}/image-tag/${moduleName}`;

/** Value of an image-tag parameter before the first gated build has run. */
export const IMAGE_TAG_PLACEHOLDER = "pending-first-build";

interface LambdaConfig {
  name: string;           // Module name (e.g., "textGeneration")
  // Lambda function this build deploys to. Omit for modules that don't run on
  // Lambda; the build role then gets no Lambda permissions at all.
  functionName?: string;
  sourceDir: string;      // Source directory for Docker build (relative to repo root)
  // For ECS-hosted modules: SSM parameters (written by the owning ECS stack)
  // holding the exact cluster and service names that run this module's image.
  // After a successful push the build registers a task definition revision
  // pinned to the new image digest and rolls that one service onto it.
  ecsServiceSsmParams?: { cluster: string; service: string };
}

interface CICDStackProps extends cdk.StackProps {
  githubRepo: string;
  githubBranch?: string;
  environmentName?: string;
  /** Prefix of the environment this pipeline deploys; scopes every grant. */
  stackPrefix: string;
  lambdaFunctions: LambdaConfig[];
  pathFilters?: string[];
}

export class CICDStack extends cdk.Stack {
  public readonly ecrRepositories: { [key: string]: ecr.Repository } = {};
  public readonly buildProjects: { [key: string]: codebuild.IProject } = {};
  /**
   * One role per build project, keyed by module name. Each role can only push
   * to its own repository and deploy its own function or service, so one
   * module's build can't overwrite another module's image or deployment.
   */
  public readonly buildRoles: { [key: string]: iam.IRole } = {};
  public readonly connectionArn: string;

  constructor(scope: Construct, id: string, props: CICDStackProps) {
    super(scope, id, props);

    const envName = props.environmentName ?? "dev";

    // Create artifacts for pipeline
    const sourceOutput = new codepipeline.Artifact();

    // Create the pipeline
    const pipeline = new codepipeline.Pipeline(this, "DockerImagePipeline", {
      pipelineName: `${id}-DockerImagePipeline`,
    });

    const username = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      "pipt-owner-name"
    );

    // TEMPORARY: Using GitHub PAT instead of CodeStar Connections.
    // Once CodeStar Connection is authorized in the AWS Console, switch back to CodeStarConnectionsSourceAction.
    // To create the PAT secret, run:
    //   aws secretsmanager create-secret \
    //     --name github-personal-access-token \
    //     --secret-string '{"my-github-token": "<YOUR-GITHUB-TOKEN>"}' \
    //     --profile <YOUR-PROFILE-NAME>

    // --- CodeStar Connections (commented out - switch back once connection is authorized) ---
    // const githubConnection = new codeconnections.CfnConnection(
    //   this,
    //   "GitHubConnection",
    //   {
    //     connectionName: `${id}-github-connection`,
    //     providerType: "GitHub",
    //   }
    // );
    // this.connectionArn = githubConnection.attrConnectionArn;
    // new cdk.CfnOutput(this, "GitHubConnectionArn", {
    //   value: githubConnection.attrConnectionArn,
    //   description: "ARN of the GitHub connection. After deployment, authorize this connection in the AWS Console.",
    // });
    // pipeline.addStage({
    //   stageName: "Source",
    //   actions: [
    //     new codepipeline_actions.CodeStarConnectionsSourceAction({
    //       actionName: "GitHub",
    //       owner: username,
    //       repo: props.githubRepo,
    //       branch: props.githubBranch ?? "main",
    //       connectionArn: githubConnection.attrConnectionArn,
    //       output: sourceOutput,
    //       triggerOnPush: true,
    //     }),
    //   ],
    // });
    // --- End CodeStar Connections ---

    // TEMPORARY: GitHub PAT-based source action
    const githubToken = cdk.SecretValue.secretsManager(
      "github-personal-access-token",
      { jsonField: "my-github-token" }
    );

    this.connectionArn = ""; // Placeholder — will be set when switching back to CodeStar Connections

    pipeline.addStage({
      stageName: "Source",
      actions: [
        new codepipeline_actions.GitHubSourceAction({
          actionName: "GitHub",
          owner: username,
          repo: props.githubRepo,
          branch: props.githubBranch ?? "main",
          oauthToken: githubToken,
          output: sourceOutput,
          trigger: codepipeline_actions.GitHubTrigger.WEBHOOK,
        }),
      ],
    });

    // Create build actions for each Lambda function
    const buildActions: codepipeline_actions.CodeBuildAction[] = [];

    props.lambdaFunctions.forEach((lambdaConfig) => {
      // Create ECR repository. Tags are immutable: every build pushes a unique
      // tag, and deployments reference a digest or one of those tags, so what
      // a deployment points at can never be silently replaced.
      const repoName = `${id.toLowerCase()}-${lambdaConfig.name.toLowerCase()}`;
      const ecrRepo = new ecr.Repository(this, `${lambdaConfig.name}Repo`, {
        repositoryName: repoName,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        imageScanOnPush: true,
      });

      ecrRepo.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: "LambdaPullAccess",
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal("lambda.amazonaws.com")],
          actions: [
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage",
            "ecr:BatchCheckLayerAvailability",
          ],
          conditions: {
            StringEquals: {
              "aws:SourceAccount": this.account,
            },
          },
        })
      );

      this.ecrRepositories[lambdaConfig.name] = ecrRepo;
      cdk.Tags.of(ecrRepo).add("module", lambdaConfig.name);
      cdk.Tags.of(ecrRepo).add("env", envName);

      // Approved-image pointer. Created once with a placeholder by a custom
      // resource rather than an ssm.StringParameter: the build owns the value
      // afterwards, and a CloudFormation-managed parameter would be reset to
      // the template value whenever that resource changed.
      const imageTagParamName = getImageTagSsmParam(props.stackPrefix, lambdaConfig.name);
      const imageTagParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${imageTagParamName}`;
      new cr.AwsCustomResource(this, `${lambdaConfig.name}ImageTagParamInit`, {
        onCreate: {
          service: "SSM",
          action: "putParameter",
          parameters: {
            Name: imageTagParamName,
            Value: IMAGE_TAG_PLACEHOLDER,
            Type: "String",
            Overwrite: false,
            Description: `Newest ${lambdaConfig.name} image tag that passed the ECR scan gate (written by CI/CD)`,
          },
          // Keep an existing value on re-creation of this resource.
          ignoreErrorCodesMatching: "ParameterAlreadyExists",
          physicalResourceId: cr.PhysicalResourceId.of(imageTagParamName),
        },
        // No onUpdate/onDelete: the parameter outlives this resource on purpose
        // so a stack update or teardown can't erase the deployed-image record.
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["ssm:PutParameter"],
            resources: [imageTagParamArn],
          }),
        ]),
        installLatestAwsSdk: false,
      });

      // One role per build project (not shared), scoped to this module only.
      const buildRole = new iam.Role(this, `${lambdaConfig.name}BuildRole`, {
        assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
        description: `CodeBuild role for the ${lambdaConfig.name} image build (${props.stackPrefix})`,
      });
      this.buildRoles[lambdaConfig.name] = buildRole;

      buildRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter", "ssm:PutParameter"],
          resources: [imageTagParamArn],
        })
      );

      if (lambdaConfig.functionName) {
        // Exact function in this environment only. Function names are
        // `${StackPrefix}-Api-...`, and several prefixes share the account, so
        // a `*-` wildcard would also match every other environment's function.
        const functionArn = `arn:aws:lambda:${this.region}:${this.account}:function:${lambdaConfig.functionName}`;
        buildRole.addToPolicy(
          new iam.PolicyStatement({
            actions: [
              "lambda:GetFunction",
              "lambda:GetFunctionConfiguration",
              "lambda:UpdateFunctionCode",
              "lambda:PublishVersion",
              "lambda:GetAlias",
              "lambda:UpdateAlias",
            ],
            resources: [functionArn, `${functionArn}:*`],
          })
        );
      }

      // ECS redeploy permissions are not granted here. The stack that owns each
      // ECS service grants this role UpdateService on that exact service ARN
      // (see EcsSocketStack), so the build can only redeploy that one service.

      // Create CodeBuild project
      const buildProject = new codebuild.PipelineProject(
        this,
        `${lambdaConfig.name}BuildProject`,
        {
          projectName: `${id}-${lambdaConfig.name}Builder`,
          role: buildRole,
          cache: codebuild.Cache.local(codebuild.LocalCacheMode.DOCKER_LAYER),
          environment: {
            buildImage: lambdaConfig.name === "voiceAgent" 
                ? codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0
                : codebuild.LinuxBuildImage.STANDARD_7_0,
            privileged: true,
          },
          environmentVariables: {
            AWS_ACCOUNT_ID: { value: this.account },
            AWS_REGION: { value: this.region },
            ENVIRONMENT: { value: envName },
            MODULE_NAME: { value: lambdaConfig.name },
            LAMBDA_FUNCTION_NAME: { value: lambdaConfig.functionName ?? "" },
            ECS_CLUSTER_PARAM: { value: lambdaConfig.ecsServiceSsmParams?.cluster ?? "" },
            ECS_SERVICE_PARAM: { value: lambdaConfig.ecsServiceSsmParams?.service ?? "" },
            IMAGE_TAG_PARAM: { value: imageTagParamName },
            IMAGE_TAG_PLACEHOLDER: { value: IMAGE_TAG_PLACEHOLDER },
            REPO_NAME: { value: repoName },
            REPOSITORY_URI: { value: ecrRepo.repositoryUri },
            GITHUB_USERNAME: { value: username },
            GITHUB_REPO: { value: props.githubRepo },
            PATH_FILTER: { value: lambdaConfig.sourceDir },
            // Severities that block promotion in cdk/scripts/ecr_scan_gate.sh.
            BLOCKING_SEVERITIES: { value: "CRITICAL HIGH" },
          },
          buildSpec: codebuild.BuildSpec.fromObject({
            version: "0.2",
            phases: {
              pre_build: {
                commands: [
                  "echo Logging in to Amazon ECR...",
                  "aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com",
                  "COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)",
                  // Tags are immutable, so include the build number: a retry or
                  // re-run of the same commit must not reuse an existing tag.
                  // Exported: ecr_scan_gate.sh and deploy_image.sh read it.
                  "export IMAGE_TAG=${MODULE_NAME}-${ENVIRONMENT}-${COMMIT_HASH}-b${CODEBUILD_BUILD_NUMBER}",
                  "export DOCKER_HOST=unix:///var/run/docker.sock",
                  "chmod +x $CODEBUILD_SRC_DIR/cdk/scripts/check_and_build.sh",
                  '$CODEBUILD_SRC_DIR/cdk/scripts/check_and_build.sh || { echo "Skipping build due to no changes"; exit 1; }',
                ],
              },
              build: {
                commands: [
                  'echo "Building Docker image..."',
                  // --pull: the Docker layer cache otherwise keeps reusing a stale
                  // base image, so upstream OS security patches never land.
                  `docker build --pull --build-arg REGISTRY=public.ecr.aws/docker/library/ -t $REPOSITORY_URI:$IMAGE_TAG $CODEBUILD_SRC_DIR/${lambdaConfig.sourceDir} -f $CODEBUILD_SRC_DIR/${lambdaConfig.sourceDir}/Dockerfile`,
                ],
              },
              post_build: {
                commands: [
                  // post_build runs even when the build phase failed; don't
                  // push or deploy an image that was never built.
                  'if [ "$CODEBUILD_BUILD_SUCCEEDING" != "1" ]; then echo "Build failed; skipping push and deploy."; exit 1; fi',
                  'echo "Pushing image with build tag for scanning..."',
                  "docker push $REPOSITORY_URI:$IMAGE_TAG",
                  // Fail-closed gate: any scan/API error, unfinished scan, or
                  // CRITICAL/HIGH finding exits non-zero, which fails this phase
                  // before the image is recorded as approved or deployed.
                  "chmod +x $CODEBUILD_SRC_DIR/cdk/scripts/ecr_scan_gate.sh",
                  "$CODEBUILD_SRC_DIR/cdk/scripts/ecr_scan_gate.sh",
                  // Record the approved tag and deploy it by digest to this
                  // module's Lambda function or ECS service (if any).
                  "chmod +x $CODEBUILD_SRC_DIR/cdk/scripts/deploy_image.sh",
                  "$CODEBUILD_SRC_DIR/cdk/scripts/deploy_image.sh",
                ],
              },
            },
          }),
        }
      );

      this.buildProjects[lambdaConfig.name] = buildProject;

      // Per-repository ECR access for this project's own role only.
      ecrRepo.grantPullPush(buildRole);
      // grantPullPush doesn't cover these: check_and_build.sh and
      // deploy_image.sh call describe-images, and the vulnerability gate
      // (scripts/ecr_scan_gate.sh) calls describe-image-scan-findings.
      ecrRepo.grant(buildRole, "ecr:DescribeImages", "ecr:DescribeImageScanFindings");

      // Add build action to the list
      buildActions.push(
        new codepipeline_actions.CodeBuildAction({
          actionName: `Build_${lambdaConfig.name}`,
          project: buildProject,
          input: sourceOutput,
        })
      );
    });

    // Add build stage with all build actions
    pipeline.addStage({
      stageName: "Build",
      actions: buildActions,
    });
  }
}
