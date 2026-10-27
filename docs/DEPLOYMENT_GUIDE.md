# Deployment Guide

> **Type:** Procedural Guide
> **Last updated:** 2026-06-18

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Step-by-Step Instructions](#step-by-step-instructions)
  - [Step 1: Create a GitHub Personal Access Token](#step-1-create-a-github-personal-access-token)
  - [Step 2: Verify Bedrock Model Availability](#step-2-verify-bedrock-model-availability)
  - [Step 3: Fork and Clone the Repository](#step-3-fork-and-clone-the-repository)
  - [Step 4: Upload Secrets and Parameters](#step-4-upload-secrets-and-parameters)
  - [Step 5: Bootstrap CDK](#step-5-bootstrap-cdk)
  - [Step 6: Deploy Stacks](#step-6-deploy-stacks)
  - [VPC Configuration](#vpc-configuration)
  - [Monitoring the Deployment](#monitoring-the-deployment)
- [Verification](#verification)
- [Post-Deployment](#post-deployment)
  - [Push Initial Docker Images](#push-initial-docker-images)
  - [DynamoDB Conversation Table & TTL](#dynamodb-conversation-table--ttl)
  - [Request SES Production Access (Optional)](#request-ses-production-access-optional)
  - [Build the Amplify App](#build-the-amplify-app)
  - [Create the First Admin User](#create-the-first-admin-user)
  - [Deploy the Voice Agent](#deploy-the-voice-agent)
  - [Rotating the CloudFront Signing Keys](#rotating-the-cloudfront-signing-keys)
  - [Visit the Web App](#visit-the-web-app)
- [Cleanup](#cleanup)
- [Troubleshooting](#troubleshooting)
- [Cross-References](#cross-references)

---

## Overview

This guide walks you through deploying Patient Interaction Practice Tool from scratch. You will set up AWS prerequisites, configure secrets, deploy CDK stacks, and verify the deployment. The process covers the full lifecycle from initial setup through post-deployment configuration and teardown.

---

## Prerequisites

### Required

- **AWS Account** with administrative access
- **AWS CLI v2** installed and configured (`aws configure`) with a named profile
- **Node.js 22+** and npm
- **AWS CDK CLI** installed globally: `npm install -g aws-cdk`
- **Git** installed
- **GitHub account** with a fork of the Patient Interaction Practice Tool repository
- **OpenSSL** for generating the RSA key pair used in CloudFront signed URLs (pre-installed on macOS/Linux; on Windows, available via [Git Bash](https://gitforwindows.org/) or [Win32 OpenSSL](https://slproweb.com/products/Win32OpenSSL.html))

> **Note:** Docker is **not** required locally. All Docker images are built in the cloud by CodePipeline/CodeBuild. Python is also not required locally since the Python Lambda functions and voice agent run in containers built remotely.

### Optional

- **Docker**: only needed if you want to manually build and push container images locally (not required for normal deployment).
- **Custom domain**: configured automatically via the `SesVerifiedDomain` CDK context variable. See [Custom Domain & SES](./CUSTOM_DOMAIN_AND_SES.md#amplify-custom-domain) for details.
- **Amazon SES**: for production email sending (verification emails). By default, Cognito uses its built-in email service (limited to 50 emails/day).

---

## Step-by-Step Instructions

### Step 1: Create a GitHub Personal Access Token

The CI/CD pipeline and Amplify app use a GitHub PAT to pull source code.

1. Go to [GitHub > Settings > Developer settings > Personal access tokens > Tokens (classic)](https://github.com/settings/tokens).
2. Click **Generate new token (classic)**.
3. Select scopes: `repo` (full control of private repositories) and `admin:repo_hook` (for webhooks).
4. Copy the generated token. You will need it in Step 4.

### Step 2: Verify Bedrock Model Availability

Patient Interaction Practice Tool uses several Amazon Bedrock models. These models are available by default (no manual access request is needed). However, verify they are accessible in the regions used by the application.

The application deploys to **`ca-central-1`** but makes cross-region calls to `us-east-1` for certain models that are only available there:

| Model | Region | Purpose |
|-------|--------|---------|
| **Anthropic Claude Sonnet 4.6** (`us.anthropic.claude-sonnet-4-6`) | `us-east-1` | Primary LLM for text generation |
| **Cohere Embed v4** (`cohere.embed-v4:0`) | `us-east-1` | Document and query embeddings |
| **Amazon Nova Sonic 2.0** (`amazon.nova-2-sonic-v1:0`) | `us-east-1` | Voice interactions (via AgentCore) |

To verify access, open the [Bedrock console in us-east-1](https://us-east-1.console.aws.amazon.com/bedrock/) and confirm these models appear under **Model access** as available. If any model shows as unavailable, enable it there.

> **Note:** The CDK stacks deploy to `ca-central-1`, but the application routes LLM, embedding, and voice calls to `us-east-1` where these models are hosted. This cross-region routing is handled automatically by the application code.

> **You are not limited to these regions.** The application can be deployed to any AWS region — `ca-central-1` is simply the default used by the team. To deploy elsewhere, change the region in `cdk/bin/cdk.ts`. The cross-region Bedrock calls to `us-east-1` will still work from any deployment region since the application explicitly targets `us-east-1` for model invocations regardless of where the stacks live.

### Step 3: Fork and Clone the Repository

```bash
git clone https://github.com/<YOUR-GITHUB-USERNAME>/<REPO NAME HERE>.git
cd <REPO NAME HERE>/cdk
npm install
```

### Step 4: Upload Secrets and Parameters

Before deploying, create the following secrets and parameters in AWS. These are referenced by the CDK stacks at synthesis time.

> **⚠️ Important — Always pass `--profile`:** Every AWS CLI command in this guide requires the `--profile <YOUR-AWS-PROFILE>` flag to target the correct account. If you omit it, the CLI uses the default profile which may point to a different account.

> **⚠️ Important — JSON secrets:** When creating secrets that contain JSON (like `PIPTSecrets` and `github-personal-access-token`), ensure the stored value has proper double quotes around keys and values. Shell escaping (especially on Windows) can silently corrupt JSON. After creating any JSON secret, verify it:
>
> ```bash
> aws secretsmanager get-secret-value --secret-id <SECRET-NAME> --region <YOUR-REGION> --profile <YOUR-AWS-PROFILE> --query SecretString --output text
> ```
>
> If the output doesn't look like valid JSON, fix it via the AWS Console (Secrets Manager → select the secret → Retrieve secret value → Edit → Plaintext tab → paste the correct JSON → Save).

#### Secret 1: PIPTSecrets

This secret contains the admin username for the RDS PostgreSQL instance. You choose this value; it becomes the master username for your database. The database stack reads `DB_Username` from this secret at deploy time.

<details>
<summary>macOS / Linux</summary>

```bash
aws secretsmanager create-secret \
  --name PIPTSecrets \
  --secret-string '{"DB_Username": "<YOUR-DB-ADMIN-USERNAME>"}' \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
aws secretsmanager create-secret `
  --name PIPTSecrets `
  --secret-string '{\"DB_Username\": \"<YOUR-DB-ADMIN-USERNAME>\"}' `
  --region <YOUR-REGION> `
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (CMD)</summary>

```cmd
aws secretsmanager create-secret ^
  --name PIPTSecrets ^
  --secret-string "{\"DB_Username\": \"<YOUR-DB-ADMIN-USERNAME>\"}" ^
  --region <YOUR-REGION> ^
  --profile <YOUR-AWS-PROFILE>
```

</details>

> **Important:** The RDS username must start with a letter, contain only alphanumeric characters, and be 1–63 characters long. Avoid reserved words like `admin`, `rds`, or `postgres`.

#### Secret 2: github-personal-access-token

This secret is used by the CI/CD pipeline and Amplify to access your GitHub repository.

> **⚠️ Important — JSON formatting:** The secret value must be valid JSON with double quotes around both the key and the value. It should look exactly like: `{"my-github-token": "ghp_xxxx..."}`. Shell escaping issues (especially on Windows) can silently corrupt the JSON. If the CLI gives you trouble, create/edit the secret via the AWS Console instead (see troubleshooting below).

<details>
<summary>macOS / Linux</summary>

```bash
aws secretsmanager create-secret \
  --name github-personal-access-token \
  --secret-string '{"my-github-token": "<YOUR-GITHUB-PAT>"}' \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
aws secretsmanager create-secret `
  --name github-personal-access-token `
  --secret-string '{\"my-github-token\": \"<YOUR-GITHUB-PAT>\"}' `
  --region <YOUR-REGION> `
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (CMD)</summary>

```cmd
aws secretsmanager create-secret ^
  --name github-personal-access-token ^
  --secret-string "{\"my-github-token\": \"<YOUR-GITHUB-PAT>\"}" ^
  --region <YOUR-REGION> ^
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Alternative: Create/fix via AWS Console (recommended if CLI escaping is problematic)</summary>

1. Go to **Secrets Manager** in the AWS Console → find `github-personal-access-token`
2. Click on it → scroll to **Secret value** section
3. Click **Retrieve secret value**
4. Click **Edit**
5. Switch to the **Plaintext** tab
6. Replace the content with exactly: `{"my-github-token": "<YOUR-GITHUB-PAT>"}`
7. Click **Save**

Make sure the key `my-github-token` and your token value both have double quotes around them.

</details>

#### Parameter 1: pipt-owner-name

Create an SSM parameter containing your GitHub username (the owner of the forked repository).

<details>
<summary>macOS / Linux</summary>

```bash
aws ssm put-parameter \
  --name "pipt-owner-name" \
  --value "<YOUR-GITHUB-USERNAME>" \
  --type String \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
aws ssm put-parameter `
  --name "pipt-owner-name" `
  --value "<YOUR-GITHUB-USERNAME>" `
  --type String `
  --region <YOUR-REGION> `
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (CMD)</summary>

```cmd
aws ssm put-parameter ^
  --name "pipt-owner-name" ^
  --value "<YOUR-GITHUB-USERNAME>" ^
  --type String ^
  --region <YOUR-REGION> ^
  --profile <YOUR-AWS-PROFILE>
```

</details>

#### Parameter 2: /{StackPrefix}/AllowedEmailDomains

Create a comma-separated list of email domains allowed to sign up (e.g., `gmail.com,ubc.ca`). The Cognito pre-signup Lambda reads this parameter to block registrations from unauthorized domains. Store it as a `SecureString` since it controls access.

> **Important:** The value must be comma-separated with no spaces between domains. Use `gmail.com,ubc.ca`, not `gmail.com, ubc.ca`. A space before a domain will cause sign-up validation to fail silently for that domain.

<details>
<summary>macOS / Linux</summary>

```bash
aws ssm put-parameter \
  --name "/<YOUR-STACK-PREFIX>/AllowedEmailDomains" \
  --value "<COMMA-SEPARATED-DOMAINS>" \
  --type SecureString \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
aws ssm put-parameter `
  --name "/<YOUR-STACK-PREFIX>/AllowedEmailDomains" `
  --value "<COMMA-SEPARATED-DOMAINS>" `
  --type SecureString `
  --region <YOUR-REGION> `
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (CMD)</summary>

```cmd
aws ssm put-parameter ^
  --name "/<YOUR-STACK-PREFIX>/AllowedEmailDomains" ^
  --value "<COMMA-SEPARATED-DOMAINS>" ^
  --type SecureString ^
  --region <YOUR-REGION> ^
  --profile <YOUR-AWS-PROFILE>
```

</details>

> **Example:** `--value "gmail.com,ubc.ca"` allows only users with emails from these domains to register. Add additional domains as needed, separated by commas.

#### Parameter 3: /{StackPrefix}/voiceAgentArn (Placeholder Required)

The EcsSocket stack **unconditionally** reads this SSM parameter at deploy time to configure the voice agent WebSocket connection. Even though you won't have a real voice agent ARN until post-deployment, a placeholder value **must** exist before the first `cdk deploy` or CloudFormation will fail during the EcsSocket stack creation.

Create the placeholder now. You will update it with the real ARN after deploying the voice agent (see [Deploy the Voice Agent](#deploy-the-voice-agent-optional)).

<details>
<summary>macOS / Linux</summary>

```bash
aws ssm put-parameter \
  --name "/<YOUR-STACK-PREFIX>/voiceAgentArn" \
  --value "placeholder" \
  --type String \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
aws ssm put-parameter `
  --name "/<YOUR-STACK-PREFIX>/voiceAgentArn" `
  --value "placeholder" `
  --type String `
  --region <YOUR-REGION> `
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (CMD)</summary>

```cmd
aws ssm put-parameter ^
  --name "/<YOUR-STACK-PREFIX>/voiceAgentArn" ^
  --value "placeholder" ^
  --type String ^
  --region <YOUR-REGION> ^
  --profile <YOUR-AWS-PROFILE>
```

</details>

> **Example:** If your `StackPrefix` is `PIPT`, the parameter name is `/PIPT/voiceAgentArn`. Voice features will not function with the placeholder value (they require the real ARN set up in post-deployment), but the placeholder prevents the deployment from failing.

#### Secret 3: {StackPrefix}/CloudFrontSigningKey

The API service stack uses CloudFront signed URLs to deliver patient documents securely. This requires an RSA key pair: the private key signs download URLs, and the public key lets CloudFront verify them. Without these, the `{StackPrefix}-Api` stack will fail to deploy because it reads `/{StackPrefix}/CloudFrontPublicKey` from SSM and references `{StackPrefix}/CloudFrontSigningKey` from Secrets Manager at synthesis time.

**Why this is required:** In `cdk/lib/api-service-stack.ts`, the stack calls `ssm.StringParameter.valueForStringParameter(this, "/{StackPrefix}/CloudFrontPublicKey")` to create a CloudFront `PublicKey` resource, and Lambda functions reference the `{StackPrefix}/CloudFrontSigningKey` secret at runtime to generate signed URLs. If either is missing, deployment fails.

**Step 1: Generate an RSA 2048-bit key pair.**

> **⚠️ Critical:** The private key **must** be in PKCS#1 format (starts with `-----BEGIN RSA PRIVATE KEY-----`). OpenSSL 3.x defaults to PKCS#8 format (`-----BEGIN PRIVATE KEY-----`) which will **not** work — the Lambda function will fail at runtime with `No PEM start marker found`. Always use the `-traditional` flag to force PKCS#1 output.

<details>
<summary>macOS / Linux (or Git Bash on Windows)</summary>

```bash
openssl genrsa -traditional -out private_key.pem 2048
openssl rsa -pubout -in private_key.pem -out public_key.pem
```

</details>

<details>
<summary>Windows — OpenSSL not available in PowerShell?</summary>

If `openssl` is not recognized in PowerShell or CMD, **open a new terminal using Git Bash** (installed with [Git for Windows](https://gitforwindows.org/)) and run the macOS/Linux commands above. Git Bash includes OpenSSL out of the box.

```bash
# In Git Bash (NOT PowerShell):
openssl genrsa -traditional -out private_key.pem 2048
openssl rsa -pubout -in private_key.pem -out public_key.pem
```

</details>

> **Verify the key format:** After generating, open `private_key.pem` and confirm the first line is exactly `-----BEGIN RSA PRIVATE KEY-----`. If it says `-----BEGIN PRIVATE KEY-----` (without "RSA"), you forgot the `-traditional` flag — regenerate it.

**Step 2: Store the private key in Secrets Manager.**

This is the signing key that Lambda functions use at runtime to generate time-limited signed URLs for document downloads.

<details>
<summary>macOS / Linux</summary>

```bash
aws secretsmanager create-secret \
  --name "<YOUR-STACK-PREFIX>/CloudFrontSigningKey" \
  --secret-string file://private_key.pem \
  --description "RSA private key for signing CloudFront document delivery URLs" \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
$privateKey = Get-Content -Raw private_key.pem
aws secretsmanager create-secret `
  --name "<YOUR-STACK-PREFIX>/CloudFrontSigningKey" `
  --secret-string $privateKey `
  --description "RSA private key for signing CloudFront document delivery URLs" `
  --region <YOUR-REGION> `
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (CMD)</summary>

```cmd
aws secretsmanager create-secret ^
  --name "<YOUR-STACK-PREFIX>/CloudFrontSigningKey" ^
  --secret-string file://private_key.pem ^
  --description "RSA private key for signing CloudFront document delivery URLs" ^
  --region <YOUR-REGION> ^
  --profile <YOUR-AWS-PROFILE>
```

</details>

**Step 3: Store the public key in SSM.**

CDK reads this at synthesis time to create the CloudFront `PublicKey` resource that verifies signed URLs.

<details>
<summary>macOS / Linux</summary>

```bash
aws ssm put-parameter \
  --name "/<YOUR-STACK-PREFIX>/CloudFrontPublicKey" \
  --value file://public_key.pem \
  --type String \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
$publicKey = Get-Content -Raw public_key.pem
aws ssm put-parameter `
  --name "/<YOUR-STACK-PREFIX>/CloudFrontPublicKey" `
  --value $publicKey `
  --type String `
  --region <YOUR-REGION> `
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (CMD)</summary>

```cmd
aws ssm put-parameter ^
  --name "/<YOUR-STACK-PREFIX>/CloudFrontPublicKey" ^
  --value file://public_key.pem ^
  --type String ^
  --region <YOUR-REGION> ^
  --profile <YOUR-AWS-PROFILE>
```

</details>

> **Security note:** After uploading, delete the local key files (`rm private_key.pem public_key.pem`). The private key is sensitive: anyone with access to it can generate signed URLs that bypass CloudFront access controls.

> **Rotating these keys later?** Regenerating the RSA key pair after the initial deploy is **not** a simple overwrite — CloudFront public keys are immutable and a naive redeploy deadlocks. See [Rotating the CloudFront Signing Keys](#rotating-the-cloudfront-signing-keys) in Post-Deployment for the safe procedure.

#### Summary of Required Secrets and Parameters

| Name | Type | Key/Value | Used By |
|------|------|-----------|---------|
| `PIPTSecrets` | Secrets Manager | `{"DB_Username": "..."}` | Database stack (RDS admin credentials) |
| `github-personal-access-token` | Secrets Manager | `{"my-github-token": "..."}` | CI/CD stack, Amplify stack |
| `{StackPrefix}/CloudFrontSigningKey` | Secrets Manager | RSA private key (PEM) | Api stack (Lambda signed URL generation) |
| `pipt-owner-name` | SSM Parameter (String) | GitHub username | CI/CD stack, Amplify stack |
| `/{StackPrefix}/AllowedEmailDomains` | SSM Parameter (SecureString) | Comma-separated email domains | Cognito pre-signup Lambda |
| `/{StackPrefix}/CloudFrontPublicKey` | SSM Parameter (String) | RSA public key (PEM) | Api stack (CloudFront PublicKey resource) |
| `/{StackPrefix}/voiceAgentArn` | SSM Parameter (String) | `placeholder` (updated post-deployment) | EcsSocket stack |

### Step 5: Bootstrap CDK

CDK must be bootstrapped in **two regions**: your deployment region and `us-east-1`.

**Why both regions?** The `CloudFrontWafStack` is deployed to `us-east-1` because AWS requires CloudFront-scoped WAF Web ACLs to reside in `us-east-1` regardless of where your application runs. The CDK app uses `crossRegionReferences: true` to pass the WAF ARN from the `us-east-1` stack to the Api and EcsSocket stacks in your deployment region. This cross-region reference mechanism relies on CDK's bootstrap resources (S3 bucket, SSM parameters, IAM roles) existing in both regions. If `us-east-1` is not bootstrapped, the `{StackPrefix}-CloudFrontWaf` stack deployment will fail with a "bootstrap stack not found" error.

```bash
# Bootstrap your primary deployment region
cdk bootstrap aws://<YOUR-ACCOUNT-ID>/<YOUR-REGION> \
  -c StackPrefix=<YOUR-STACK-PREFIX> \
  -c githubRepo=<REPO NAME HERE> \
  -c githubBranch=main \
  --profile <YOUR-AWS-PROFILE>

# Bootstrap us-east-1 (required for the CloudFront WAF stack)
cdk bootstrap aws://<YOUR-ACCOUNT-ID>/us-east-1 \
  -c StackPrefix=<YOUR-STACK-PREFIX> \
  -c githubRepo=<REPO NAME HERE> \
  -c githubBranch=main \
  --profile <YOUR-AWS-PROFILE>
```

> **Note:** If your deployment region IS `us-east-1`, you only need to run the command once. The second bootstrap is only needed when deploying to a different region (e.g., `ca-central-1`).

> **If bootstrapping fails**, ensure you are also passing the CDK context flags (`-c StackPrefix`, `-c githubRepo`, `-c githubBranch`) just like the deploy command. Without these, CDK may fail to synthesize the app before bootstrapping.

### Step 6: Deploy Stacks

> **Optional — Rename the DynamoDB conversation table:** The default table name is `DynamoDB-Conversation-Table` (a legacy name from the forked codebase). If you're deploying fresh and want something more specific, change this one line in `cdk/lib/api-service-stack.ts` **before** deploying:
>
> ```typescript
> this.dynamoTableName = `${id}-DynamoDB-Conversation-Table`; // parameterized with your StackPrefix
> ```
>
> Everything else is parameterized from there — the custom resource creates whatever name you set, it gets written to the SSM parameter `/{id}/TableName`, and the Python Lambdas read it from SSM at runtime. No other code changes needed.

The CDK app requires two context variables at deploy time, plus optional VPC configuration:

| Context Variable | Description | Required |
|-----------------|-------------|----------|
| `StackPrefix` | Prefix for all stack and resource names (e.g., `PIPT`) | Yes |
| `githubRepo` | Name of your GitHub repository (not the full URL) | Yes |
| `githubBranch` | Branch to track for CI/CD (default: `main`) | No |
| `voiceAgentArn` | ARN of a deployed Bedrock AgentCore voice agent (not needed for first deploy) | No |
| `SesVerifiedDomain` | Domain with a Route 53 hosted zone for SES email + Amplify custom domain | No |
| `SesIdentityVerified` | Set to `"true"` after SES domain is verified (see [Custom Domain & SES](./CUSTOM_DOMAIN_AND_SES.md)) | No |
| `SesSkipIdentityCreation` | Set to `"true"` to skip SES identity creation (when it already exists) | No |
| `createRdsServiceLinkedRole` | Set to `"true"` on first deploy to a fresh AWS account that has never used RDS (creates the RDS service-linked role) | No |
| `existingVpcId` | VPC ID to use an existing VPC instead of creating a new one (see [VPC Configuration](#vpc-configuration)) | No |
| `controlTowerStackSet` | Control Tower StackSet name for importing subnet/route table exports | No |
| `existingPublicSubnetId` | ID of an existing public subnet (skips creating a new one) | No |
| `existingVpcCidr` | CIDR of the existing VPC (e.g., `172.31.128.0/20`) | No |
| `publicSubnetCidr` | CIDR for the new public subnet — must be a small slice within the VPC range (e.g., `172.31.128.240/28`) | No |
| `availabilityZones` | JSON array of AZ names (e.g., `["us-east-1a","us-east-1b","us-east-1c"]`) | No |
| `vpcCidr` | CIDR for a new VPC (default: `10.0.0.0/16`) | No |
| `maxAzs` | Number of availability zones for a new VPC (default: `2`) | No |
| `natGateways` | Number of NAT Gateways for a new VPC (default: `1`; use `2` for prod HA) | No |

Choose one of the following deployment options:

> **Tip: Avoid long, clunky deploy commands.** Rather than passing every context variable on the CLI each time, you can put them once in the `context` section of `cdk/cdk.json` and then run a short deploy command (`cdk deploy --all --profile <YOUR-AWS-PROFILE>`). This is the recommended approach for repeated deploys — see the "Put context variables in cdk.json instead of long CLI commands" note under [VPC Configuration](#vpc-configuration). The `-c` flags shown in the options below are equivalent to setting those same keys in `cdk.json`.

#### Option A: Deploy All Stacks (Recommended for First Deployment)

```bash
cdk deploy --all \
  -c StackPrefix=<YOUR-STACK-PREFIX> \
  -c githubRepo=<REPO NAME HERE> \
  -c githubBranch=main \
  --profile <YOUR-AWS-PROFILE>
```

> **First deploy to a brand-new AWS account?** If this account has never used RDS before, add `-c createRdsServiceLinkedRole=true` to the command above. This creates the required `AWSServiceRoleForRDS` service-linked role. Omit this flag on subsequent deploys or if the account already has RDS resources.

> **Audit logging and CloudTrail.** Every deploy turns on API Gateway access logs (`/aws/apigateway/<StackPrefix>-Api-API/access`), WAF request logs (`aws-waf-logs-*` log groups; the CloudFront one is in `us-east-1`), and S3 server access and CloudFront standard logs (the `<StackPrefix>-Api-AccessLogsBucket*` bucket). Lambda handlers write structured `AUDIT` lines for every POST/PUT/DELETE and `AUTHZ_DENY` lines for every authorization denial. Query them with CloudWatch Logs Insights (`filter message = "AUTHZ_DENY"`). The `<StackPrefix>-Api-Authorization-Denial-Spike` alarm fires on more than 50 denials in 5 minutes. All of these use the same retention as the other log groups. The project doesn't create a CloudTrail trail by default, because accounts managed by AWS Organizations or Control Tower already have one, and a second copy of management events is billed. If your account has no trail (check with `aws cloudtrail describe-trails --include-shadow-trails`), add `-c EnableCloudTrail=true` to deploy the `<StackPrefix>-AuditTrail` stack.

#### Option B: Deploy Individual Stacks (Incremental Updates)

Stacks deploy in dependency order. If you only need to update a specific stack:

```bash
cdk deploy <YOUR-STACK-PREFIX>-Api \
  -c StackPrefix=<YOUR-STACK-PREFIX> \
  -c githubRepo=<REPO NAME HERE> \
  -c githubBranch=main \
  --profile <YOUR-AWS-PROFILE>
```

#### Option C: Redeploy with Voice Agent

After completing the voice agent setup, you can pass the ARN explicitly on subsequent deploys. However, the recommended approach is to store it in SSM so you do not need this flag.

```bash
cdk deploy --all \
  -c StackPrefix=<YOUR-STACK-PREFIX> \
  -c githubRepo=<REPO NAME HERE> \
  -c githubBranch=main \
  -c voiceAgentArn="arn:aws:bedrock:us-east-1:123456789012:agent-runtime/XXXXXXXXXX" \
  --profile <YOUR-AWS-PROFILE>
```

#### Stack Deployment Order

The CDK app creates the following stacks in dependency order:

1. **`{StackPrefix}-CICD`** : ECR repositories, CodeBuild projects, CodePipeline
2. **`{StackPrefix}-VpcStack`** : VPC, subnets, NAT gateway, VPC endpoints
3. **`{StackPrefix}-Database`** : RDS PostgreSQL instance, RDS Proxy, secrets
4. **`{StackPrefix}-CloudFrontWaf`** : WAF Web ACL for CloudFront (deployed to `us-east-1`)
5. **`{StackPrefix}-Api`** : API Gateway, Lambda functions, Cognito, AppSync, S3, CloudFront
6. **`{StackPrefix}-TurnServer`** : TURN server for WebRTC
7. **`{StackPrefix}-EcsSocket`** : ECS Fargate service for Socket.IO
8. **`{StackPrefix}-DBFlow`** : Database migration runner (triggers on deploy)
9. **`{StackPrefix}-Amplify`** : Amplify hosting for the React frontend

> **Note:** `--all` handles the dependency order automatically. Deployment takes approximately 30–45 minutes on first run.

### VPC Configuration

By default, CDK creates a brand-new VPC with public, private, and isolated subnets. If you need to deploy into an **existing VPC** (e.g., one created by AWS Control Tower Account Factory, or a shared-services VPC), you can configure this entirely through context variables — no source code edits required.

#### Option 1: New VPC (Default — No Extra Config Needed)

If you omit all VPC context variables, CDK creates a fresh VPC with:
- CIDR `10.0.0.0/16` (override with `-c vpcCidr=...`)
- 2 availability zones (override with `-c maxAzs=3`)
- 1 NAT Gateway (override with `-c natGateways=2` for production high availability)
- Public, private (with egress), and isolated subnets

> **NAT Gateway count.** A single NAT Gateway is the default and is sufficient for this app. Only set `natGateways=2` if you have a specific high-availability requirement.

```bash
# Example: new VPC (single NAT Gateway is sufficient for this app)
cdk deploy --all \
  -c StackPrefix=<YOUR-STACK-PREFIX> \
  -c githubRepo=<REPO NAME HERE> \
  -c maxAzs=3 \
  --profile <YOUR-AWS-PROFILE>
```

#### Option 2: Existing VPC with AWS Control Tower Exports

If your account was provisioned by AWS Control Tower (Account Factory), your VPC's subnet IDs, route tables, and CIDRs are exported as CloudFormation outputs by a StackSet. Provide the VPC ID and StackSet name:

```bash
cdk deploy --all \
  -c StackPrefix=<YOUR-STACK-PREFIX> \
  -c githubRepo=<REPO NAME HERE> \
  -c existingVpcId=vpc-0abc123def456789a \
  -c controlTowerStackSet="StackSet-AWSControlTowerBP-VPC-ACCOUNT-FACTORY-V1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \
  -c publicSubnetCidr="172.31.128.240/28" \
  --profile <YOUR-AWS-PROFILE>
```

<details>
<summary>Alternative: Put context variables in cdk.json instead of long CLI commands</summary>

If you don't want to deal with a long deploy command every time, add the context variables to the `context` section of `cdk/cdk.json`:

```jsonc
{
  "context": {
    "StackPrefix": "<YOUR-STACK-PREFIX>",
    "githubRepo": "<YOUR-GITHUB-REPO>",
    "githubBranch": "<YOUR-BRANCH>",
    "existingVpcId": "<YOUR-VPC-ID>",
    "controlTowerStackSet": "<YOUR-CONTROL-TOWER-STACKSET-NAME>",
    "existingVpcCidr": "<YOUR-VPC-CIDR>",
    "publicSubnetCidr": "<YOUR-PUBLIC-SUBNET-CIDR>",
    "existingPublicSubnetId": "",
    "availabilityZones": ["<AZ-1>", "<AZ-2>", "<AZ-3>"],
    "skipVpcEndpoints": true
  }
}
```

Then your deploy command becomes just:

```bash
cdk deploy --all --profile <YOUR-AWS-PROFILE>
```

</details>

**How to find your Control Tower StackSet name:**
1. Open the [CloudFormation console](https://console.aws.amazon.com/cloudformation/).
2. Go to **Exports**.
3. Look for exports matching the pattern `StackSet-AWSControlTowerBP-VPC-ACCOUNT-FACTORY-*-PrivateSubnet1AID`.
4. The prefix before `-PrivateSubnet1AID` is your StackSet name.

**Required context variables for this option:**

| Variable | Description |
|----------|-------------|
| `existingVpcId` | The VPC ID (e.g., `vpc-0abc123...`) |
| `controlTowerStackSet` | Full StackSet name including the GUID suffix |
| `publicSubnetCidr` | A small CIDR (e.g., `/28`) within your VPC range for the public subnet with IGW/NAT. **Must not overlap** with existing private subnets. |

**Optional context variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `existingPublicSubnetId` | `""` (create new) | If a public subnet already exists, provide its ID to skip creating IGW/NAT resources |
| `existingVpcCidr` | `172.31.128.0/20` | Your VPC's CIDR block (used for security group rules) |
| `availabilityZones` | Derived from stack environment | JSON array of AZ names if auto-detection isn't available |

#### Option 3: Existing VPC Without Control Tower

If you have an existing VPC that was **not** created by Control Tower (no StackSet exports), you have two choices:

1. **Create matching CloudFormation exports manually** that follow the Control Tower naming convention, then use Option 2.
2. **Use the default new-VPC path** and peer/connect it to your existing networking as needed.

> **Note:** A future enhancement will add `Vpc.fromLookup()` support which automatically discovers subnets and route tables without requiring CloudFormation exports. For now, Option 2 with manual exports is the supported path for existing VPCs.

#### Important Notes

- **`publicSubnetCidr` must be a small CIDR slice** (e.g., `/27` or `/28`), NOT the entire VPC CIDR. It needs to fit within the VPC range and must not overlap with existing subnets. For example, if your VPC is `172.31.128.0/20`, a good choice is `172.31.143.240/28` (the last 16 IPs in the range).
- **Availability zones** are auto-detected from the stack's `env` (account + region). You only need to pass `availabilityZones` if CDK cannot resolve them (e.g., environment-agnostic synthesis without `-c` or `env`).
- **The `StackPrefix` context variable is used for route naming** in the existing-VPC branch. Ensure it's consistent across deploys to avoid orphaned routes.

#### Migrating from Source-Edited Deployments

If you previously deployed by editing the hardcoded values in `vpc-stack.ts` directly, you can migrate to the context-driven approach with a no-op deploy:

1. Add the values you previously hardcoded to your `cdk.json` context section:

```jsonc
{
  "context": {
    "StackPrefix": "<REPO NAME HERE>-production",
    "existingVpcId": "vpc-0abc123...",
    "controlTowerStackSet": "StackSet-AWSControlTowerBP-VPC-ACCOUNT-FACTORY-V1-df80d055-...",
    "existingVpcCidr": "172.31.128.0/20",
    "publicSubnetCidr": "172.31.128.0/20"
  }
}
```

> **Note:** For existing deployments, set `publicSubnetCidr` to the same value that was previously used (the VPC CIDR). This ensures CloudFormation sees no change. On future fresh deployments, use a proper small CIDR instead.

2. Run `cdk diff` to confirm **no changes** are detected:

```bash
cdk diff --all \
  -c StackPrefix=<REPO NAME HERE>-production \
  -c githubRepo=<REPO NAME HERE> \
  -c existingVpcId=vpc-0abc123... \
  -c controlTowerStackSet="StackSet-AWSControlTowerBP-..." \
  -c existingVpcCidr="172.31.128.0/20" \
  -c publicSubnetCidr="172.31.128.0/20" \
  --profile <YOUR-AWS-PROFILE>
```

3. If the diff is clean (no resource changes), deploy to confirm:

```bash
cdk deploy --all \
  -c StackPrefix=<REPO NAME HERE>-production \
  -c githubRepo=<REPO NAME HERE> \
  -c existingVpcId=vpc-0abc123... \
  -c controlTowerStackSet="StackSet-AWSControlTowerBP-..." \
  -c existingVpcCidr="172.31.128.0/20" \
  -c publicSubnetCidr="172.31.128.0/20" \
  --profile <YOUR-AWS-PROFILE>
```

4. Once confirmed, remove any manual edits from `vpc-stack.ts` and rely solely on context going forward.

### Monitoring the Deployment

While the stacks deploy, you can monitor progress in real time through the AWS Console:

1. Open the [CloudFormation console](https://console.aws.amazon.com/cloudformation/) in your deployment region.
2. You will see each stack appear as it begins creating (e.g., `{StackPrefix}-VpcStack`, `{StackPrefix}-Database`, etc.).
3. Click into any stack and go to the **Events** tab to see individual resource creation progress.
4. A stack showing `CREATE_IN_PROGRESS` is still deploying. Wait for `CREATE_COMPLETE`.
5. If a stack shows `ROLLBACK_IN_PROGRESS` or `CREATE_FAILED`, check the Events tab for the specific resource and error message that caused the failure. Do not attempt to delete or redeploy the stack until it reaches `ROLLBACK_COMPLETE`. CloudFormation must finish rolling back all provisioned resources before it can accept new operations on that stack.

> **Tip:** Also check the [CloudFormation console in us-east-1](https://us-east-1.console.aws.amazon.com/cloudformation/) for the `{StackPrefix}-CloudFrontWaf` stack, since it deploys to that region separately.

---

## Verification

After deployment completes, verify the following:

1. **Check stack status.** Open the [CloudFormation console](https://console.aws.amazon.com/cloudformation/) and confirm all stacks show `CREATE_COMPLETE` or `UPDATE_COMPLETE`.

2. **Verify Bedrock access.** Open the [Lambda console](https://console.aws.amazon.com/lambda/), find the function named `{StackPrefix}-Api-TextGenLambdaDockerFunction`, create a test event, and invoke it. Check CloudWatch Logs for successful initialization.

3. **Confirm API Gateway.** Navigate to the [API Gateway console](https://console.aws.amazon.com/apigateway/) and verify the `{StackPrefix}` REST API exists with deployed stages.

4. **Check ECS service.** Open the [ECS console](https://console.aws.amazon.com/ecs/) and confirm the socket server service has running tasks.

5. **Verify database connectivity.** Check CloudWatch Logs for the DBFlow Lambda to confirm migrations ran successfully.

---

## Post-Deployment

### Push Initial Docker Images

The CI/CD pipeline builds and pushes all Docker images (text generation, data ingestion, socket server, voice agent). For the first deployment, the ECR repositories are empty. Trigger the pipeline by either:

- **Pushing a commit** to your tracked branch, or
- **Clicking "Release change"** in the [CodePipeline console](https://console.aws.amazon.com/codepipeline/) for the `{StackPrefix}-CICD-DockerImagePipeline` pipeline

Wait for the pipeline to complete successfully. Once done, the Lambda functions and ECS services will have images to run.

> **Expected behavior:** Until the pipeline finishes pushing the `socketServer` image, the ECS socket service will show `STOPPED` tasks with `CannotPullContainerError`. This is normal on first deployment. The service retries automatically and will stabilize once the image is available in ECR (typically 10–15 minutes after the pipeline starts). Do not manually intervene or delete the service.

### DynamoDB Conversation Table & TTL

#### First-time deploy — no manual steps required

On a fresh deploy in a new account/region, everything is handled automatically:

- A custom resource (`EnsureConversationTable`) creates the table during CloudFormation deployment.
- TTL is enabled on the `expireAt` attribute as part of the same operation.
- All downstream Lambdas have the table ready before they ever run.
- Other DynamoDB tables in the account are **completely unaffected** — both the table creation and TTL enablement target this single table by name. The custom resource's IAM policy is scoped to `arn:aws:dynamodb:<region>:<account>:table/DynamoDB-Conversation-Table` only. TTL is a per-table setting in DynamoDB, not an account-wide setting — enabling it here does not touch any other table in your account.

#### How it works

The `DynamoDB-Conversation-Table` is **not owned by CDK**. This project was forked from an earlier codebase where the table was created manually in the AWS console and never linked to CloudFormation. Importing it into CDK (`cdk import`) was attempted but failed repeatedly, so CDK only **references** the table (via `Table.fromTableName(...)`) for IAM policies, Lambda environment variables, and CloudWatch alarms — it does not manage its lifecycle.

To handle the case where the table doesn't exist yet (fresh deploy), the stack includes a custom resource that runs on every deploy:

1. Calls `CreateTable` for the configured table name (passed via environment variable, not hardcoded) with PAY_PER_REQUEST billing and key = `SessionId`.
2. If the table **already exists**, catches `ResourceInUseException` and does nothing — completely idempotent.
3. If the table **does not exist**, creates it, waits for `ACTIVE` status, then enables TTL on `expireAt`.

Because CDK doesn't own the table, `cdk destroy` will **not** delete it or its data.

#### Legacy environments — manually enabling TTL

This only applies if the table was created **before** the custom resource existed (i.e., it was manually created in the console without TTL). In that scenario the custom resource sees the table already exists, catches the exception, and skips everything — including TTL setup.

**Check if TTL is already enabled:** DynamoDB console → select `DynamoDB-Conversation-Table` > **Additional settings** tab > look for "Time to live attribute: `expireAt` (Enabled)". If it shows enabled, you're done.

If TTL is **not** enabled on a pre-existing table, run the following **once**:

<details>
<summary>macOS / Linux</summary>

```bash
aws dynamodb update-time-to-live \
  --table-name DynamoDB-Conversation-Table \
  --time-to-live-specification "Enabled=true, AttributeName=expireAt" \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
aws dynamodb update-time-to-live `
  --table-name DynamoDB-Conversation-Table `
  --time-to-live-specification "Enabled=true, AttributeName=expireAt" `
  --region <YOUR-REGION> `
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (CMD)</summary>

```cmd
aws dynamodb update-time-to-live ^
  --table-name DynamoDB-Conversation-Table ^
  --time-to-live-specification "Enabled=true, AttributeName=expireAt" ^
  --region <YOUR-REGION> ^
  --profile <YOUR-AWS-PROFILE>
```

</details>

#### What TTL does once enabled

DynamoDB automatically deletes expired items in the background:
- Question, DTP, and recommendation cache items after **7 days**
- Chat history items after **90 days**

#### Safety notes

| Concern | Answer |
|---------|--------|
| Will this affect other DynamoDB tables in my account? | **No.** The Lambda's IAM policy only grants access to the configured table (default: `DynamoDB-Conversation-Table`). The table name is parameterized via an environment variable, not hardcoded. Every API call targets that single table by name. Other tables are untouched. |
| Will `cdk destroy` delete the table? | **No.** CDK references it via `fromTableName`, it doesn't own the resource. The table and all its data survive stack deletion. |

### Request SES Production Access (Optional)

If you need to send more than 50 verification emails per day, SES is configured via CDK context variables. See [Custom Domain & SES](./CUSTOM_DOMAIN_AND_SES.md) for the full two-step deployment process, custom domain setup, and troubleshooting.

### Build the Amplify App

After the first deployment, Amplify needs to run its initial build:

1. Open the [Amplify console](https://console.aws.amazon.com/amplify/).
2. Find your app (named `{StackPrefix}-Amplify-amplify`).
3. If the build has not triggered automatically, click **Run build** on the `main` branch.
4. Wait for the build to complete (typically 3–5 minutes).

#### Fallback: Amplify Console Can't Detect Branches

If the Amplify Console UI fails to detect branches (common when using a PAT-based connection instead of the GitHub App integration), you can create the branch and trigger a build entirely via CLI:

**Get your Amplify App ID:**

```bash
aws amplify list-apps \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE> \
  --query "apps[?contains(name, '<YOUR-STACK-PREFIX>')].appId" \
  --output text
```

**Create the branch:**

```bash
aws amplify create-branch \
  --app-id <APP_ID> \
  --branch-name <BRANCH_NAME> \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>
```

**Trigger a build:**

```bash
aws amplify start-job \
  --app-id <APP_ID> \
  --branch-name <BRANCH_NAME> \
  --job-type RELEASE \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>
```

**Check build status:**

```bash
aws amplify list-jobs \
  --app-id <APP_ID> \
  --branch-name <BRANCH_NAME> \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>
```

**Get the Amplify URL:**

```bash
aws amplify get-branch \
  --app-id <APP_ID> \
  --branch-name <BRANCH_NAME> \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE> \
  --query "branch.displayName"
```

The app will be available at `https://<BRANCH_NAME>.<APP_ID>.amplifyapp.com`.

### Create the First Admin User

On a fresh deployment there are no admin users. Every account that signs up through the app is automatically assigned the **student** role by the post-confirmation Lambda. There is no admin yet to promote anyone from inside the app, so the person who deployed the infrastructure creates the first admin by invoking the one-off `bootstrapAdmin` Lambda that the Api stack deploys.

Once the first admin exists, they can promote existing users to instructors and manage the platform from the app UI — see the [Admin Workflow](./USER_GUIDE.md#admin-workflow) in the User Guide.

**Steps:**

1. **Sign up through the app.** Open the deployed app URL and create the account you want to become the admin (using an email on one of your `AllowedEmailDomains`). Confirm the email and log in once so the user is fully created in Cognito. This account starts as a **student**.

2. **Invoke the bootstrap Lambda** with that user's email. The function name is in the `{StackPrefix}-Api-BootstrapAdminFunctionName` CloudFormation output (it's `{StackPrefix}-Api-bootstrapAdmin` by default). The caller needs `lambda:InvokeFunction` on it; the function isn't reachable through API Gateway.

   ```bash
   aws lambda invoke \
     --function-name <YOUR-STACK-PREFIX>-Api-bootstrapAdmin \
     --cli-binary-format raw-in-base64-out \
     --payload '{"email":"<USER-EMAIL>"}' \
     --region <YOUR-REGION> \
     --profile <YOUR-AWS-PROFILE> \
     bootstrap-admin-result.json
   ```

   `bootstrap-admin-result.json` contains `{"ok": true, ...}` on success. It returns `ok: false` with a reason if the user hasn't signed in yet, or if **any admin already exists**; the function only creates the first admin.

3. **Reload the app.** Roles are read from the database on every request, so there's no need to log out; the admin views appear on the next page load.

> **Note:** the **database is the single source of truth** for authorization. All role checks (admin, instructor, student) read `users.roles`; token claims such as `cognito:groups` are never consulted. After bootstrap, manage admins and instructors in-app. Demotions take effect on the user's next request, and every role change (including the bootstrap) is recorded in the `role_audit_log` table with who made it, the target, and the old and new roles.
>
> **Upgrading from a version that used the Cognito `admin` group:** that group is removed on deploy and no longer grants access. Users the old flow promoted keep `admin` in `users.roles`, so review who holds it after upgrading and demote anyone who shouldn't.

### Deploy the Voice Agent

The voice agent runs on **Amazon Bedrock AgentCore** and is required for the voice mode functionality. It requires the CDK stacks to be deployed first (since the CI/CD pipeline builds and pushes the voice-agent Docker image to ECR). Follow this order of operations:

#### Step A: Complete the Initial CDK Deployment

Deploy all stacks without a voice agent ARN (Steps 5–6 above). This creates the ECR repository for the voice agent image.

#### Step B: Push the Voice Agent Image

The CI/CD pipeline builds and pushes all Docker images, including the voice agent. Trigger it by either:

- **Pushing a commit** to your tracked branch, or
- **Clicking "Release change"** in the [CodePipeline console](https://console.aws.amazon.com/codepipeline/) for the `{StackPrefix}-CICD-DockerImagePipeline` pipeline

Wait for the pipeline to complete successfully before proceeding.

#### Step C: Set Up AgentCore and Deploy the Voice Agent

Follow the detailed instructions in [AgentCore Voice Agent Setup](./AGENTCORE_VOICE_AGENT_SETUP.md) to configure Bedrock AgentCore and deploy the voice agent through the AWS console.

Once complete, you will have a voice agent runtime ARN.

#### Step D: Store the ARN and Redeploy

Store the ARN in SSM so the EcsSocket stack can connect to it (this overwrites the placeholder created in Step 4):

<details>
<summary>macOS / Linux</summary>

```bash
aws ssm put-parameter \
  --name "/<YOUR-STACK-PREFIX>/voiceAgentArn" \
  --value "<YOUR-VOICE-AGENT-ARN>" \
  --type String \
  --overwrite \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
aws ssm put-parameter `
  --name "/<YOUR-STACK-PREFIX>/voiceAgentArn" `
  --value "<YOUR-VOICE-AGENT-ARN>" `
  --type String `
  --overwrite `
  --region <YOUR-REGION> `
  --profile <YOUR-AWS-PROFILE>
```

</details>

<details>
<summary>Windows (CMD)</summary>

```cmd
aws ssm put-parameter ^
  --name "/<YOUR-STACK-PREFIX>/voiceAgentArn" ^
  --value "<YOUR-VOICE-AGENT-ARN>" ^
  --type String ^
  --overwrite ^
  --region <YOUR-REGION> ^
  --profile <YOUR-AWS-PROFILE>
```

</details>

Then redeploy the EcsSocket stack to pick up the new value:

```bash
cdk deploy <YOUR-STACK-PREFIX>-EcsSocket \
  -c StackPrefix=<YOUR-STACK-PREFIX> \
  -c githubRepo=<REPO NAME HERE> \
  -c githubBranch=main \
  --profile <YOUR-AWS-PROFILE>
```

> **Note:** Voice features will not work until all four steps are complete. The ECS socket server uses the stored ARN to establish a SigV4-signed WebSocket connection to the AgentCore runtime.

### Rotating the CloudFront Signing Keys

At some point you may need to regenerate the RSA key pair set up in [Step 4, Secret 3](#secret-3-stackprefixcloudfrontsigningkey) (routine rotation, or because the private key was exposed). This is **not** as simple as overwriting the two stored values — CloudFront public keys are **immutable**, so changing them requires care.

**Why a naive rotation deadlocks:** If you only update the SSM public key and Secrets Manager private key and then run `cdk deploy`, CloudFormation must *replace* the `PublicKey` resource (its encoded key can't be changed in place). That replacement gets stuck because:

- A public key that belongs to a key group **cannot be deleted**, and
- A key group **cannot be emptied** (it must contain at least one key).

The deploy fails, and trying to fix it by hand in the console hits the same wall: deleting the key reports "it's part of a key group," and dissociating it reports "at least one key must be associated."

**How the stack avoids this:** `cdk/lib/api-service-stack.ts` names the `PublicKey` resource with a version suffix driven by a `cfKeyVersion` value (default `1`):

```typescript
const cfKeyVersion =
  this.node.tryGetContext("cfKeyVersion") ?? process.env.CF_KEY_VERSION ?? "1";

const cfPublicKey = new cloudfront.PublicKey(
  this,
  `${id}-CfSigningPublicKey-v${cfKeyVersion}`,
  { encodedKey: cfPublicKeyPem, /* ... */ }
);
```

Bumping `cfKeyVersion` makes CloudFormation create a **new** `PublicKey` resource, repoint the key group to it, update the distribution and the Lambda `CLOUDFRONT_KEY_PAIR_ID`, and only then delete the old key — sidestepping the deadlock entirely.

**Rotation steps:**

1. **Generate a new key pair** using the same commands as [Step 4, Secret 3, Step 1](#secret-3-stackprefixcloudfrontsigningkey) (remember the `-traditional` flag for PKCS#1 format).
2. **Update both stored values** so they remain a matching pair:
   - Overwrite Secrets Manager `{StackPrefix}/CloudFrontSigningKey` with the new **private** key (use `aws secretsmanager put-secret-value`).
   - Overwrite SSM `/{StackPrefix}/CloudFrontPublicKey` with the new **public** key (use `aws ssm put-parameter --overwrite`).
   - Verify they match: `openssl rsa -in private_key.pem -pubout` should equal the stored public key.
3. **Deploy the Api stack with an incremented version** (same command format as [Option B](#option-b-deploy-individual-stacks-incremental-updates), with the added `cfKeyVersion` flag):

   ```bash
   cdk deploy <YOUR-STACK-PREFIX>-Api -c StackPrefix=<YOUR-STACK-PREFIX> -c githubRepo=<REPO NAME HERE> -c githubBranch=main -c cfKeyVersion=2 --profile <YOUR-AWS-PROFILE>
   ```

   Increment `cfKeyVersion` on every subsequent rotation (`3`, `4`, ...).
4. **Verify** by requesting a document or profile picture in the app — signed URLs should return `200`, not `403`. You can also confirm the key group now points to the new key ID: `aws cloudfront list-key-groups --query "KeyGroupList.Items[].KeyGroup.KeyGroupConfig" --profile <YOUR-AWS-PROFILE>`.

> **⚠️ Keep the pair consistent.** The private key (Secrets Manager) and the public key (SSM/CloudFront) must always be two halves of the same pair. If you update one without the other — for example, changing the secret via the console but not completing the deploy — signed URLs will fail with `403` because the signature no longer matches the public key CloudFront trusts. If you need delivery restored immediately before you can deploy, revert the secret to the previous private key so it matches the public key still deployed in CloudFront.

### Visit the Web App

Once the Amplify build completes, your app is live at the default Amplify domain:

```text
https://main.<AMPLIFY-APP-ID>.amplifyapp.com
```

Find the exact URL in the Amplify console or in the CDK stack outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name <YOUR-STACK-PREFIX>-Amplify \
  --query "Stacks[0].Outputs[?OutputKey=='AmplifyDefaultDomain'].OutputValue" \
  --output text \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>
```

---

## Cleanup

To tear down all deployed resources, you must first disable termination protection on the critical stacks, then destroy them.

### Step 1: Disable Stack Termination Protection

The VPC and Api stacks have CloudFormation termination protection enabled. You must disable it before `cdk destroy` will work:

1. Open the [CloudFormation console](https://console.aws.amazon.com/cloudformation/) in your deployment region.
2. For each of these stacks — `{StackPrefix}-VpcStack`, `{StackPrefix}-Api`:
   - Select the stack.
   - Click **Stack actions** → **Edit termination protection**.
   - Set to **Disabled** and confirm.

### Step 2: Disable RDS Deletion Protection

The RDS instance itself also has deletion protection enabled (separate from stack termination protection):

1. Open the [RDS console](https://console.aws.amazon.com/rds/).
2. Select the database instance.
3. Click **Modify**.
4. Uncheck **Enable deletion protection**.
5. Apply immediately.

### Step 3: Destroy Stacks

```bash
cdk destroy --all \
  -c StackPrefix=<YOUR-STACK-PREFIX> \
  -c githubRepo=<REPO NAME HERE> \
  -c githubBranch=main \
  --profile <YOUR-AWS-PROFILE>
```

> **Note:** S3 buckets have `removalPolicy: RETAIN`, so you need to empty and delete them manually after stack deletion.

To delete individual stacks, destroy them in reverse dependency order:

```bash
cdk destroy <YOUR-STACK-PREFIX>-Amplify -c StackPrefix=<YOUR-STACK-PREFIX> -c githubRepo=<REPO NAME HERE> -c githubBranch=main --profile <YOUR-AWS-PROFILE>
cdk destroy <YOUR-STACK-PREFIX>-DBFlow -c StackPrefix=<YOUR-STACK-PREFIX> -c githubRepo=<REPO NAME HERE> -c githubBranch=main --profile <YOUR-AWS-PROFILE>
cdk destroy <YOUR-STACK-PREFIX>-EcsSocket -c StackPrefix=<YOUR-STACK-PREFIX> -c githubRepo=<REPO NAME HERE> -c githubBranch=main --profile <YOUR-AWS-PROFILE>
cdk destroy <YOUR-STACK-PREFIX>-TurnServer -c StackPrefix=<YOUR-STACK-PREFIX> -c githubRepo=<REPO NAME HERE> -c githubBranch=main --profile <YOUR-AWS-PROFILE>
cdk destroy <YOUR-STACK-PREFIX>-Api -c StackPrefix=<YOUR-STACK-PREFIX> -c githubRepo=<REPO NAME HERE> -c githubBranch=main --profile <YOUR-AWS-PROFILE>
cdk destroy <YOUR-STACK-PREFIX>-CloudFrontWaf -c StackPrefix=<YOUR-STACK-PREFIX> -c githubRepo=<REPO NAME HERE> -c githubBranch=main --profile <YOUR-AWS-PROFILE>
cdk destroy <YOUR-STACK-PREFIX>-Database -c StackPrefix=<YOUR-STACK-PREFIX> -c githubRepo=<REPO NAME HERE> -c githubBranch=main --profile <YOUR-AWS-PROFILE>
cdk destroy <YOUR-STACK-PREFIX>-VpcStack -c StackPrefix=<YOUR-STACK-PREFIX> -c githubRepo=<REPO NAME HERE> -c githubBranch=main --profile <YOUR-AWS-PROFILE>
cdk destroy <YOUR-STACK-PREFIX>-CICD -c StackPrefix=<YOUR-STACK-PREFIX> -c githubRepo=<REPO NAME HERE> -c githubBranch=main --profile <YOUR-AWS-PROFILE>
```

---

## Troubleshooting

### Stack deletion fails for Database stack

**Cause:** The RDS instance has deletion protection enabled, which prevents CloudFormation from deleting it.

**Fix:**

1. Disable RDS deletion protection (see [Step 2 in Cleanup](#step-2-disable-rds-deletion-protection)).
2. Retry `cdk destroy`.

### RDS username constraint error

**Cause:** The `DB_Username` value in `PIPTSecrets` uses a reserved word or invalid characters.

**Fix:** Update the secret with a valid username (starts with a letter, alphanumeric only, 1–63 chars):

```bash
aws secretsmanager update-secret \
  --secret-id PIPTSecrets \
  --secret-string '{"DB_Username": "piptadmin"}' \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>
```

### Amplify build fails

**Cause:** Environment variables are not available during build, or the GitHub token is invalid.

**Fix:**

1. Verify the `github-personal-access-token` secret exists and contains a valid token.
2. Check that the token has `repo` scope.
3. Verify the repository name matches the `githubRepo` context variable.

### CodePipeline source action fails

**Cause:** The GitHub PAT has expired or lacks required permissions.

**Fix:**

1. Generate a new GitHub PAT with `repo` and `admin:repo_hook` scopes.
2. Update the secret:

```bash
aws secretsmanager update-secret \
  --secret-id github-personal-access-token \
  --secret-string '{"my-github-token": "<NEW-TOKEN>"}' \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>
```

### GitHub token secret not stored as valid JSON

**Cause:** On some systems (particularly Windows), escape characters can cause the secret value to be stored as malformed JSON rather than a proper `{"my-github-token": "..."}` object. This happens due to differences in how shells handle quotes and escape characters across Windows CMD, PowerShell, macOS, and Linux.

**Symptoms:** CodePipeline or Amplify fails with authentication errors even though the token is correct. Retrieving the secret value shows it is not valid JSON (e.g., extra backslashes, missing quotes, or the string stored as plain text instead of a JSON object).

**Fix:** Delete the secret and recreate it:

```bash
# Delete the malformed secret (force immediate deletion)
aws secretsmanager delete-secret \
  --secret-id github-personal-access-token \
  --force-delete-without-recovery \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>

# Wait a few seconds, then recreate it
aws secretsmanager create-secret \
  --name github-personal-access-token \
  --secret-string '{"my-github-token": "<YOUR-GITHUB-PAT>"}' \
  --region <YOUR-REGION> \
  --profile <YOUR-AWS-PROFILE>
```

> **Tip:** After creating the secret, verify the stored value is valid JSON by retrieving it:
>
> ```bash
> aws secretsmanager get-secret-value --secret-id github-personal-access-token --region <YOUR-REGION> --profile <YOUR-AWS-PROFILE> --query SecretString --output text
> ```
>
> The output should be exactly: `{"my-github-token": "ghp_xxxxx..."}`

### Lambda functions return errors after first deploy

**Cause:** ECR repositories are empty. The Docker Lambda functions have no image to run.

**Fix:** Push initial images by triggering the CI/CD pipeline (see [Push Initial Docker Images](#push-initial-docker-images)) or push a commit to the tracked branch.

### ECS socket service shows STOPPED tasks after first deploy

**Cause:** The ECS service starts immediately after the stack deploys, but the ECR repository for `socketServer` is empty until the CI/CD pipeline finishes building and pushing the image. The service cannot pull a container image that doesn't exist yet, so tasks fail with `CannotPullContainerError` and restart repeatedly.

**Fix:** This resolves itself. Once the CI/CD pipeline pushes the `socketServer` image to ECR, the ECS service will pull it on the next retry and stabilize. No manual action is needed. If tasks are still failing 20+ minutes after the pipeline completes successfully, check that the image tag in ECR matches what the task definition expects (`latest`).

### Voice features not working

**Cause:** Nova Sonic models are only available in `us-east-1`. If your deployment region is different, the voice service makes cross-region calls. The voice agent must also be deployed to Bedrock AgentCore and its ARN configured.

**Fix:**

1. Ensure Bedrock model access is enabled in `us-east-1` for Nova Sonic models.
2. Verify the ECS task role has `bedrock:InvokeModelWithBidirectionalStream` permission in `us-east-1`.
3. Confirm the voice agent is deployed to Bedrock AgentCore (see [Deploy the Voice Agent](#deploy-the-voice-agent-optional)).
4. Verify the `voiceAgentArn` is set, either via the `-c` context flag or the `/{StackPrefix}/voiceAgentArn` SSM parameter.

### Text generation or embeddings not working

**Cause:** Claude Sonnet 4.6 and Cohere Embed v4 are called in `us-east-1` via cross-region inference, but the models may not be accessible there.

**Fix:**

1. Open the [Bedrock console in us-east-1](https://us-east-1.console.aws.amazon.com/bedrock/).
2. Navigate to **Model access** and verify the models are available.
3. Check CloudWatch Logs for the `TextGenLambdaDockerFunction` for specific error messages.
4. Ensure the Lambda execution role has `bedrock:InvokeModel` permissions for the model ARNs in `us-east-1`.

---

## Cross-References

- [AgentCore Voice Agent Setup](./AGENTCORE_VOICE_AGENT_SETUP.md) : Console-side voice agent configuration
- [Database Migrations](./DATABASE_MIGRATIONS.md) : Creating and running schema changes
- [Modification Guide](./MODIFICATION_GUIDE.md) : Customizing colors, API, LLM, and frontend

### Optional Setup

- [Custom Domain & SES](./CUSTOM_DOMAIN_AND_SES.md) : SES email delivery, custom domain, and Amplify custom domain
