import * as cdk from "aws-cdk-lib";
import * as amplify from "aws-cdk-lib/aws-amplify";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { ApiServiceStack } from "./api-service-stack";
import { getSocketUrlSsmParam } from "./ecs-socket-stack";


export class AmplifyStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    apiStack: ApiServiceStack,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    // Read socket URL from SSM (written by EcsSocket stack) — no cross-stack export dependency.
    const stackPrefix = this.node.tryGetContext("StackPrefix");
    const socketUrl = ssm.StringParameter.valueForStringParameter(this, getSocketUrlSsmParam(stackPrefix));

    // Context values
    const githubRepoName = this.node.tryGetContext("githubRepo");

    // GitHub owner name from SSM
    const githubOwner = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      "pipt-owner-name"
    );

    // TEMPORARY: Using GitHub PAT instead of CodeStar Connections.
    // Once CodeStar Connection is authorized in the AWS Console, switch back to GitHub App approach.
    // To create the PAT secret, run:
    //   aws secretsmanager create-secret \
    //     --name github-personal-access-token \
    //     --secret-string '{"my-github-token": "<YOUR-GITHUB-TOKEN>"}' \
    //     --profile <YOUR-PROFILE-NAME>

    // --- CodeStar Connections (commented out - switch back once connection is authorized) ---
    // const githubConnection = new codeconnections.CfnConnection(
    //   this,
    //   "AmplifyGitHubConnection",
    //   {
    //     connectionName: `${id}-amplify-github-connection`,
    //     providerType: "GitHub",
    //   }
    // );
    // --- End CodeStar Connections ---

    // TEMPORARY: PAT-based Amplify App
    const githubToken = cdk.SecretValue.secretsManager(
      "github-personal-access-token",
      { jsonField: "my-github-token" }
    );

    // REVIEW: unsafeUnwrap() resolves the secret at CDK synthesis time, embedding the GitHub PAT
    // in plaintext in the CloudFormation template (stored in S3). Anyone with access to the
    // CloudFormation template can read the PAT. Migrate to CodeStar Connections (commented out above)
    // to avoid this exposure. The CodeStar approach passes a connection ARN instead of a raw token.
    const amplifyApp = new amplify.CfnApp(this, `${id}-amplifyApp`, {
      name: `${id}-amplify`,
      repository: `https://github.com/${githubOwner}/${githubRepoName}`,
      accessToken: githubToken.unsafeUnwrap(), // TEMPORARY: Using PAT instead of CodeStar Connection
      platform: "WEB",
      environmentVariables: [
        { name: "VITE_AWS_REGION", value: this.region },
        { name: "VITE_COGNITO_USER_POOL_ID", value: apiStack.getUserPoolId() },
        { name: "VITE_COGNITO_USER_POOL_CLIENT_ID", value: apiStack.getUserPoolClientId() },
        { name: "VITE_API_ENDPOINT", value: apiStack.getEndpointUrl() },
        { name: "VITE_IDENTITY_POOL_ID", value: apiStack.getIdentityPoolId() },
        { name: "VITE_SOCKET_URL", value: socketUrl },
        { name: "VITE_APPSYNC_GRAPHQL_URL", value: apiStack.appSyncApi.graphqlUrl },
      ],
      buildSpec: `version: 1
applications:
  - appRoot: frontend
    frontend:
      phases:
        preBuild:
          commands:
            - pwd
            - nvm install 22
            - nvm use 22
            - npm ci
        build:
          commands:
            - npm run build
      artifacts:
        baseDirectory: dist
        files:
          - '**/*'
`,
      customRules: [
        {
          source: "</^[^.]+$|.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>",
          target: "/",
          status: "404-200",
        },
      ],
    });

    // --- CodeStar property overrides (commented out - switch back once connection is authorized) ---
    // amplifyApp.addPropertyOverride("OauthToken", cdk.Aws.NO_VALUE);
    // amplifyApp.addPropertyOverride("AccessToken", cdk.Aws.NO_VALUE);
    // iamServiceRole: this.createAmplifyServiceRole(id).roleArn,
    // (amplifyApp as any).addOverride("Properties.Repository",
    //   `https://github.com/${githubOwner}/${githubRepoName}`
    // );
    // --- End CodeStar property overrides ---

    // Set up branches
    const mainBranch = new amplify.CfnBranch(this, `${id}-mainBranch`, {
      appId: amplifyApp.attrAppId,
      branchName: "main",
      enableAutoBuild: true,
    });

    const chatPlayground = new amplify.CfnBranch(this, `${id}-chatplaygroundBranch`, {
      appId: amplifyApp.attrAppId,
      branchName: "chat-playground",
      enableAutoBuild: true,
    });

    // Custom domain — maps the verified SES domain to the main branch.
    // Amplify provisions an SSL certificate and creates the required DNS records
    // in Route 53 automatically via the enableAutoSubDomain setting.
    const skipCustomDomain =  this.node.tryGetContext("AmplifySkipCustomDomain") === "true";
    const domainName = this.node.tryGetContext("SesVerifiedDomain");
    if (domainName && !skipCustomDomain) {
      const customDomain = new amplify.CfnDomain(this, `${id}-CustomDomain`, {
        appId: amplifyApp.attrAppId,
        domainName: domainName,
        subDomainSettings: [
          {
            branchName: "main",
            prefix: "", // root domain
          },
          {
            branchName: "main",
            prefix: "www", // www subdomain → redirects to root
          },
        ],
        enableAutoSubDomain: false,
      });

      new cdk.CfnOutput(this, "CustomDomainUrl", {
        value: `https://${domainName}`,
        description: "Custom domain URL for the frontend",
      });
    }


    // Output the Amplify App ID and default domain
    new cdk.CfnOutput(this, "AmplifyAppId", {
      value: amplifyApp.attrAppId,
      description: "Amplify App ID",
    });

    new cdk.CfnOutput(this, "AmplifyDefaultDomain", {
      value: amplifyApp.attrDefaultDomain,
      description: "Amplify Default Domain",
    });
  }

  /**
   * Create an IAM service role for Amplify to pull from GitHub via CodeStar Connection
   * TEMPORARY: Commented out while using PAT-based approach. Uncomment when switching back.
   */
  // private createAmplifyServiceRole(id: string): cdk.aws_iam.Role {
  //   const role = new cdk.aws_iam.Role(this, `${id}-AmplifyServiceRole`, {
  //     assumedBy: new cdk.aws_iam.ServicePrincipal("amplify.amazonaws.com"),
  //     description: "Service role for Amplify to access CodeStar Connection",
  //   });
  //   role.addToPolicy(
  //     new cdk.aws_iam.PolicyStatement({
  //       effect: cdk.aws_iam.Effect.ALLOW,
  //       actions: [
  //         "codeconnections:GetConnection",
  //         "codeconnections:UseConnection",
  //         "codeconnections:GetInstallationUrl",
  //         "codeconnections:GetIndividualAccessToken",
  //         "codeconnections:StartOAuthHandshake",
  //         "codestar-connections:GetConnection",
  //         "codestar-connections:UseConnection",
  //       ],
  //       resources: ["*"],
  //     })
  //   );
  //   return role;
  // }
}