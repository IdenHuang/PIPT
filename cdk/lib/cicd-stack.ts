import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as iam from "aws-cdk-lib/aws-iam";

interface LambdaConfig {
  name: string;           // Module name (e.g., "textGeneration")
  functionName: string;   // Lambda function name (or ECS service identifier)
  sourceDir: string;      // Source directory for Docker build (relative to repo root)
}

interface CICDStackProps extends cdk.StackProps {
  githubRepo: string;
  githubBranch?: string;
  environmentName?: string;
  lambdaFunctions: LambdaConfig[];
  pathFilters?: string[];
}

export class CICDStack extends cdk.Stack {
  public readonly ecrRepositories: { [key: string]: ecr.Repository } = {};
  public readonly buildProjects: { [key: string]: codebuild.IProject } = {};
  public readonly connectionArn: string;

  constructor(scope: Construct, id: string, props: CICDStackProps) {
    super(scope, id, props);

    const envName = props.environmentName ?? "dev";

    // Create a common role for all CodeBuild projects
    const codeBuildRole = new iam.Role(this, "DockerBuildRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
    });

    // ECR access is granted per repository inside the loop below, not account-wide.

    codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:PublishVersion",
          "lambda:GetAlias",
          "lambda:UpdateAlias",
        ],
        resources: [
          `arn:aws:lambda:${this.region}:${this.account}:function:*-TextGenLambdaDockerFunction`,
          `arn:aws:lambda:${this.region}:${this.account}:function:*-TextGenLambdaDockerFunction:*`,
          `arn:aws:lambda:${this.region}:${this.account}:function:*-DataIngestLambdaDockerFunction`,
          `arn:aws:lambda:${this.region}:${this.account}:function:*-DataIngestLambdaDockerFunction:*`,
        ],
      })
    );

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
      // Create ECR repository
      const repoName = `${id.toLowerCase()}-${lambdaConfig.name.toLowerCase()}`;
      const ecrRepo = new ecr.Repository(this, `${lambdaConfig.name}Repo`, {
        repositoryName: repoName,
        imageTagMutability: ecr.TagMutability.MUTABLE,
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

      // Create CodeBuild project
      const buildProject = new codebuild.PipelineProject(
        this,
        `${lambdaConfig.name}BuildProject`,
        {
          projectName: `${id}-${lambdaConfig.name}Builder`,
          role: codeBuildRole,
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
            LAMBDA_FUNCTION_NAME: { value: lambdaConfig.functionName },
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
                  "IMAGE_TAG=${MODULE_NAME}-${ENVIRONMENT}-${COMMIT_HASH}",
                  "export DOCKER_HOST=unix:///var/run/docker.sock",
                  "chmod +x $CODEBUILD_SRC_DIR/cdk/scripts/check_and_build.sh",
                  '$CODEBUILD_SRC_DIR/cdk/scripts/check_and_build.sh || { echo "Skipping build due to no changes"; exit 1; }',
                ],
              },
              build: {
                commands: [
                  'echo "Building Docker image..."',
                  `docker build --build-arg REGISTRY=public.ecr.aws/docker/library/ -t $REPOSITORY_URI:$IMAGE_TAG $CODEBUILD_SRC_DIR/${lambdaConfig.sourceDir} -f $CODEBUILD_SRC_DIR/${lambdaConfig.sourceDir}/Dockerfile`,
                ],
              },
              post_build: {
                commands: [
                  'echo "Pushing image with commit tag for scanning..."',
                  "docker push $REPOSITORY_URI:$IMAGE_TAG",
                  // Fail-closed gate: any scan/API error, unfinished scan, or
                  // CRITICAL/HIGH finding exits non-zero, which fails this phase
                  // before the :latest push and Lambda deploy below.
                  "chmod +x $CODEBUILD_SRC_DIR/cdk/scripts/ecr_scan_gate.sh",
                  "$CODEBUILD_SRC_DIR/cdk/scripts/ecr_scan_gate.sh",
                  'echo "Scan passed. Tagging and pushing as latest..."',
                  "docker tag $REPOSITORY_URI:$IMAGE_TAG $REPOSITORY_URI:latest",
                  "docker push $REPOSITORY_URI:latest",
                  'echo "Checking if Lambda function exists before updating..."',
                  `bash -c '
                    if aws lambda get-function --function-name $LAMBDA_FUNCTION_NAME &>/dev/null; then
                      echo "Updating Lambda function to use the new image..."
                      aws lambda update-function-code \
                        --function-name $LAMBDA_FUNCTION_NAME \
                        --image-uri $REPOSITORY_URI:latest

                      echo "Waiting for function update to complete..."
                      aws lambda wait function-updated --function-name $LAMBDA_FUNCTION_NAME

                      echo "Publishing new version..."
                      NEW_VERSION=$(aws lambda publish-version \
                        --function-name $LAMBDA_FUNCTION_NAME \
                        --query "Version" --output text)

                      if [ -z "$NEW_VERSION" ]; then
                        echo "ERROR: Failed to publish version. Skipping alias update."
                        exit 0
                      fi
                      echo "Published version: $NEW_VERSION"

                      # Check if a live alias exists and update it
                      if aws lambda get-alias --function-name $LAMBDA_FUNCTION_NAME --name live &>/dev/null; then
                        PREV_VERSION=$(aws lambda get-alias \
                          --function-name $LAMBDA_FUNCTION_NAME \
                          --name live \
                          --query "FunctionVersion" --output text)
                        echo "Previous alias version: $PREV_VERSION"

                        echo "Updating live alias to version $NEW_VERSION..."
                        aws lambda update-alias \
                          --function-name $LAMBDA_FUNCTION_NAME \
                          --name live \
                          --function-version "$NEW_VERSION"

                        echo "Rollback command if needed: aws lambda update-alias --function-name $LAMBDA_FUNCTION_NAME --name live --function-version $PREV_VERSION"
                      else
                        echo "No live alias found. Skipping alias update."
                      fi
                    else
                      echo "Lambda function $LAMBDA_FUNCTION_NAME does not exist yet. Skipping update."
                    fi
                  '`,
                ],
              },
            },
          }),
        }
      );

      this.buildProjects[lambdaConfig.name] = buildProject;

      // Grant permissions to push to ECR
      ecrRepo.grantPullPush(buildProject);
      // grantPullPush doesn't cover these: check_and_build.sh calls describe-images,
      // and the vulnerability gate (scripts/ecr_scan_gate.sh) calls
      // describe-image-scan-findings. Without them the gate fails every build.
      ecrRepo.grant(buildProject, "ecr:DescribeImages", "ecr:DescribeImageScanFindings");

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
