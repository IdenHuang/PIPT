# Patient Interaction Practice Tool Bedrock AgentCore Voice Agent Setup

> **Document Type:** Supplementary Procedural Guide
> **Relationship:** This document supplements the core documentation set. See [Documentation Index](./README.md) for the full document listing.
> **Last updated:** 2026-05-30

**Date:** April 27, 2026
**Scope:** Console-side configuration of the Bedrock AgentCore voice agent and how it connects to the CDK deployment
**Audience:** Developers deploying or maintaining the Patient Interaction Practice Tool voice feature

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture: How AgentCore Fits In](#2-architecture-how-agentcore-fits-in)
3. [Prerequisites](#3-prerequisites)
4. [Step-by-Step Console Setup](#4-step-by-step-console-setup)
5. [Linking the Agent to the CDK Deployment](#5-linking-the-agent-to-the-cdk-deployment)
6. [Updating the Voice Agent After Code Changes](#6-updating-the-voice-agent-after-code-changes)
7. [Verification](#7-verification)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Overview

The Patient Interaction Practice Tool voice feature uses **Amazon Bedrock AgentCore** to host the voice agent container. Both text and voice chat flow through the ECS Socket.IO server — this unified WebSocket approach replaced the earlier Lambda + AppSync design for text chat, giving both modalities consistent low-latency streaming and a single connection point for the frontend. Voice additionally requires a connection from the socket server to the AgentCore runtime for bidirectional audio streaming with Nova Sonic 2.0. AgentCore provides the managed runtime for this: it hosts the container, handles health checks, and exposes a SigV4-authenticated WebSocket endpoint that the socket server connects to.

The voice agent container itself is built and pushed to ECR by the CI/CD pipeline (`cdk/voice-agent/`), but the **AgentCore runtime** that hosts it must be created and configured in the AWS Console. The CDK deployment then references the AgentCore runtime ARN so the socket server knows where to route voice traffic.

---

## 2. Architecture: How AgentCore Fits In

```text
Frontend (React)
    |  Socket.IO (audio frames + control messages)
Socket Server (ECS Fargate, server.js)
    |  SigV4-signed WebSocket (bedrock-agentcore.{region}.amazonaws.com)
AgentCore Runtime (managed by AWS)
    -> Voice Agent Container (bot.py, pulled from ECR)
        |  Bedrock Bidirectional Stream
    Amazon Nova Sonic 2.0
```

Key points:
- The **socket server** (ECS) is the bridge between the frontend and the voice agent. It authenticates the student via Cognito, then opens a SigV4-signed WebSocket to the AgentCore runtime endpoint.
- **AgentCore** pulls the container image from ECR, runs it, and proxies WebSocket connections to the container's `/ws` endpoint on port 8080.
- The **voice agent container** (`bot.py`) uses the `bedrock-agentcore` SDK to expose three endpoints: `GET /ping` (health check), `POST /invocations` (HTTP handler), and `WS /ws` (bidirectional audio streaming).
- The socket server needs the **AgentCore runtime ARN** to construct the WebSocket URL. This ARN is passed via the `VOICE_AGENT_ENDPOINT` environment variable on the ECS socket service.

---

## 3. Prerequisites

Before configuring AgentCore in the console, ensure the following are in place:

1. **ECR repository exists** - The CI/CD stack creates an ECR repo for the voice agent (`voiceAgent`). Confirm it exists in the ECR console and contains at least one image. The pipeline builds and pushes on every commit that touches `cdk/voice-agent/`.

2. **Image is ARM64** - The voice agent Dockerfile and CI/CD build project are configured for ARM64 (Graviton).

3. **Bedrock model access** - Nova Sonic 2.0 (`amazon.nova-2-sonic-v1:0`) must be enabled in the **us-east-1** region. The voice agent always connects to us-east-1 for Nova Sonic regardless of the deployment region. Request access via the Bedrock console > Model access if not already enabled.

4. **VPC and subnets** - The Patient Interaction Practice Tool VPC must be deployed (`cdk deploy {StackPrefix}-VpcStack`). You will need the VPC ID and **private subnet IDs** when configuring the AgentCore network settings.

5. **ECS socket service deployed** - The ECS socket stack should be deployed (`{StackPrefix}-EcsSocket`) because you will need its security group during the AgentCore networking setup.

---

## 4. Step-by-Step Console Setup

### 4.1 Navigate to the Host Agent/Tool Page

1. Open the **AWS Console** in the region where Patient Interaction Practice Tool is deployed (e.g. `ca-central-1`).
2. Go to **Amazon Bedrock** > **AgentCore**.
3. In the left sidebar under **Build**, click **Runtime**.
4. You will see the **Runtime resources** page. Click **Host agent/tool**.

This opens the **Host agent or tool** configuration page where you will fill in all the details below.

### 4.2 Agent or Tool Details

| Setting | Value | Notes |
|---------|-------|-------|
| Name | `pipt-voice-agent` | Or any descriptive name for your environment |
| Description | *(optional)* | e.g. `Patient Interaction Practice Tool voice agent for Nova Sonic patient simulation` |

### 4.3 Agent Source

Under **Agent source**, you need to choose where AgentCore pulls the container from.

1. For **Source type**, select **ECR container** (not S3 source).
2. You can either paste the full ECR image URI directly, or click **Browse images** to select from your repositories.
3. If browsing: select the voice agent ECR repository created by the CICD stack, then select the **latest** image tag.

The URI will look something like: `{account}.dkr.ecr.{region}.amazonaws.com/{repo}:latest`

### 4.4 Permissions (IAM)

Under **Permissions** > **IAM permissions**:

1. Select **Create a new service role**. AgentCore will create a default service role with basic permissions (ECR pull, CloudWatch logs). You will add the remaining permissions after the agent is hosted (see [Section 4.10](#410-add-iam-permissions-to-the-service-role)).

### 4.5 Inbound Auth

Leave the defaults here. The default configuration uses **HTTP protocol** with **IAM permissions** for authentication. No changes needed.

### 4.6 Filesystem Configuration

No changes needed. Skip this section.

### 4.7 Advanced Configurations (Networking)

**This is the most important section. Pay close attention to each setting.**

**Security type:**
- Set this to **VPC**. Do NOT leave it as Public. The voice agent needs to be inside the VPC to reach RDS Proxy and Secrets Manager.

**VPC:**
- Select the Patient Interaction Practice Tool VPC. It will be named based on your deployment stack prefix (e.g. `{StackPrefix}-VpcStack/...`).

**Subnets:**
- Select the **private subnets** associated with your stack prefix. Do NOT select public subnets and do NOT select isolated subnets.
- **Why private?** Private subnets have NAT Gateway access for outbound internet (needed for the Bedrock API in us-east-1) while keeping the agent off the public internet. Isolated subnets have no internet access at all, so the agent would fail to reach Bedrock. Public subnets would assign a public IP to the agent, which is unnecessary and increases the attack surface.

**Security group:**
- You need to use the same security group that the ECS socket server uses. To find it:
  1. Open a new browser tab.
  2. Go to **Amazon ECS** in the console.
  3. Find the ECS cluster whose name matches your stack prefix (e.g. `{StackPrefix}-EcsSocket-...`).
  4. Click into the cluster, then click on the service. It will be named something like `{StackPrefix}-EcsSocket-SocketService...`.
  5. Go to the **Configuration and networking** tab.
  6. Scroll down to the **Network configuration** section.
  7. Copy the **security group ID** shown there.
  8. Go back to the AgentCore tab and select that security group.

Using the same security group as the socket server ensures the voice agent has the correct network access rules (outbound HTTPS for Bedrock/Secrets Manager, outbound PostgreSQL for RDS Proxy) without needing to create and configure a new one.

### 4.8 Advanced Configurations (Environment Variables)

Still within **Advanced configurations**, scroll down to the **Environment variables** section. This is where you specify key-value pairs that get passed to the container at startup. The voice agent reads these to know which region to use, where to find database credentials, and how to connect to RDS.

Add the following environment variables:

| Key | Value | Notes |
|-----|-------|-------|
| `AWS_REGION` | Your deployment region (e.g. `ca-central-1`) | Used for KVS, Secrets Manager, and RDS connections |
| `AWS_DEFAULT_REGION` | Same as `AWS_REGION` | Boto3 fallback when the primary region env var is not picked up |
| `BEDROCK_REGION` | `us-east-1` | Nova Sonic 2.0 is only available in us-east-1, regardless of your deployment region |
| `SM_DB_CREDENTIALS` | The Secrets Manager secret name for the RDS **user** credentials (the secret clients use to connect to RDS) | Go to **Secrets Manager** in the console and find the secret named `{StackPrefix}/userCredentials/rdsDbCredential` (described as "Secrets for clients to connect to RDS"), created by the Database stack. Copy the **secret name** (not the ARN). ⚠️ Use the `userCredentials` secret — **not** the admin secret at `{StackPrefix}/credentials/rdsDbCredential` and **not** the `TableCreator` secret. |
| `RDS_PROXY_ENDPOINT` | The RDS Proxy endpoint for the user proxy | Found in the Database stack CloudFormation outputs, or in the **RDS** console under **Proxies**. It will look something like `{StackPrefix}-database-userproxy-....rds.amazonaws.com`. |
| `TABLE_NAME` | `{StackPrefix}-Api-DynamoDB-Conversation-Table` | The DynamoDB table used to persist conversation history. All other services read this from CDK-managed config — the voice agent must have it set manually here since it runs outside CDK. |
These match the environment variables that were previously defined in the now-removed `VoiceAgentStack`. Without them, the voice agent will fail to connect to the database or reach Nova Sonic in the correct region.

You do **not** need to add a guardrail variable here. The socket server sends the guardrail to the voice agent automatically when each voice session starts. (Advanced: setting `BEDROCK_GUARDRAIL_ID` and `BEDROCK_GUARDRAIL_REGION` on the runtime overrides what the socket server sends.)

### 4.9 Host the Agent

Review all your settings and click **Host agent/tool** at the bottom of the page. AgentCore will pull the container image, start it, and begin health-checking the `/ping` endpoint. The status should transition to **Active** within a few minutes.

### 4.10 Add IAM Permissions to the Service Role

Once the agent is hosted, you will likely see a popup or notification asking you to edit the permissions for the IAM role associated with this agent. The default service role only has basic permissions (ECR pull, CloudWatch logs), so you need to add the policies the voice agent needs at runtime.

1. Go to **IAM** > **Roles** in the console.
2. Search for the default service role created for your AgentCore agent. It will have a name related to your agent (e.g. containing `agentcore` or the agent name you chose).
3. Click on the role and go to the **Permissions** tab.
4. Under **Permissions policies**, you should already see one policy: `AmazonBedrockAgentCoreRuntimeExecutionPolicy_...` (this covers ECR pull, CloudWatch logs, and basic Bedrock access).
5. Click **Add permissions** > **Attach policies** and add these two managed policies:
   - `AmazonDynamoDBFullAccess_v2` (for conversation history in DynamoDB)
   - `AWSSecretsManagerClientReadOnlyAccess` (for reading RDS credentials from Secrets Manager)
6. Add the guardrail permission. The voice agent needs this to screen content; without it, voice chat shows "I'm unable to respond right now" instead of the AI's replies. The deployment generates the exact policy for you, so there is nothing to fill in:
   1. In a new browser tab, open **CloudFormation** (make sure the region in the top-right matches your deployment, e.g. Canada (Central)).
   2. Click the stack named **`{StackPrefix}-Api`**, then the **Outputs** tab.
   3. Find **`AgentCoreGuardrailPolicy`** and copy its entire **Value** (it starts with `{"Version":"2012-10-17"`).
   4. Back on the IAM role, click **Add permissions** > **Create inline policy**.
   5. Click the **JSON** button, delete everything in the editor, and paste the value you copied.
   6. Click **Next**, name the policy `PiptGuardrailAccess`, and click **Create policy**.

   The same value is also printed at the end of `cdk deploy` as `{StackPrefix}-Api.AgentCoreGuardrailPolicy`.

   <details>
   <summary>What the policy looks like</summary>

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "ApplyPiptGuardrail",
         "Effect": "Allow",
         "Action": "bedrock:ApplyGuardrail",
         "Resource": "arn:aws:bedrock:<region>:<account-id>:guardrail/<guardrail-id>"
       }
     ]
   }
   ```

   The `Resource` value is the `BedrockGuardrailArn` output of the same stack.
   </details>

These policies, combined with the default `AmazonBedrockAgentCoreRuntimeExecutionPolicy`, cover all the permissions the voice agent needs.

> **Upgrade order:** on an existing runtime, add the `bedrock:ApplyGuardrail` permission *before* updating the runtime to a voice-agent image that fails closed. Otherwise every AI transcript is replaced with the "unable to respond" message until the permission is added.

---

## 5. Linking the Agent to the CDK Deployment

The socket server needs the AgentCore runtime ARN to construct the SigV4-signed WebSocket URL.

### 5.1 Finding the Runtime ARN

1. Go to **Amazon Bedrock** > **AgentCore** in the console.
2. In the left sidebar under **Build**, click **Runtime**.
3. On the **Runtime resources** page, click on your agent (e.g. `pipt-voice-agent`).
4. Under **Agent and tool details**, you will find the **Runtime ARN**. Copy this value.

### 5.2 Passing the ARN to the CDK Deployment

There are two ways to pass the ARN. Both work, but SSM is cleaner for ongoing use.

**Option A: CDK Context (good for initial setup or one-off deploys)**

Pass the ARN directly when deploying:

```bash
cd cdk
cdk deploy --all -c StackPrefix={YourStackPrefix} -c githubRepo={YourGithubRepo} -c githubBranch={YourBranch} -c voiceAgentArn="arn:aws:bedrock-agentcore:{region}:{account-id}:runtime/{runtime-id}" --profile {your-aws-profile}
```

The `bin/cdk.ts` entry point reads this via `app.node.tryGetContext("voiceAgentArn")` and passes it to the `EcsSocketStack`, which sets it as the `VOICE_AGENT_ENDPOINT` environment variable on the socket server ECS task.

**Option B: SSM Parameter (recommended for ongoing use)**

Store the ARN in SSM Parameter Store so you don't need to pass it on every deploy:

```bash
aws ssm put-parameter \
  --name "/{StackPrefix}/voiceAgentArn" \
  --value "arn:aws:bedrock-agentcore:{region}:{account}:runtime/{runtime-id}" \
  --type String \
  --overwrite
```

The `EcsSocketStack` falls back to reading `/{StackPrefix}/voiceAgentArn` from SSM when no context value is provided. This is the cleaner long-term approach since the ARN is stable once the runtime is created.

### 5.3 What Happens at Runtime

1. The socket server reads `VOICE_AGENT_ENDPOINT` from its environment.
2. When a student starts a voice session, the socket server calls `connectToVoiceAgent()` in `server.js`.
3. This constructs the WebSocket URL: `wss://bedrock-agentcore.{region}.amazonaws.com/runtimes/{ARN}/ws`
4. The request is signed with SigV4 using the ECS task role credentials (which must have `bedrock-agentcore:InvokeAgentRuntime` and `bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream` permissions, already configured in `ecs-socket-stack.ts`).
5. AgentCore proxies the WebSocket to the voice agent container's `/ws` endpoint.
6. The voice agent (`bot.py` > `nova_sonic.py`) opens a bidirectional stream to Nova Sonic and relays audio/text back through the WebSocket chain.

---

## 6. Updating the Voice Agent After Code Changes

When you push code changes to `cdk/voice-agent/`, the CI/CD pipeline builds a new Docker image and pushes it to ECR. However, AgentCore does not automatically pick up the new image. You need to manually trigger an update so the runtime uses the latest container.

This also applies if the voice agent behavior is not updating after a redeploy, or if something else caused the ECR image to change (e.g. a new CodePipeline run).

**Steps to update:**

1. Go to **Amazon Bedrock** > **AgentCore** in the console.
2. In the left sidebar under **Build**, click **Runtime**.
3. On the **Runtime resources** page, click on your agent (e.g. `pipt-voice-agent`).
4. Click **Update Hosting**.
5. Go to **Agent Source** and click **Browse Images**. Verify that the image selected is the **latest** one (check the image digest or push timestamp to confirm).
6. Scroll to the bottom and click **Host agent/tool**.

This generates a new version of the hosted agent while keeping the same ARN and all other configuration intact. The new version will include your latest code changes. The runtime will briefly restart while it pulls and starts the new image.

---

## 7. Verification

### Check AgentCore runtime status

In the Bedrock console > AgentCore > Runtime > Runtime resources, confirm the agent status is **Active** and the health check is passing.

### Check socket server logs

After redeploying the ECS socket stack with the ARN, check the socket server CloudWatch logs for:

```text
Using AgentCore WebSocket for ARN: arn:aws:bedrock-agentcore:...
Connecting to AgentCore WebSocket: wss://bedrock-agentcore...
AgentCore WebSocket connected (session: ...)
```

If you see `VOICE_AGENT_ENDPOINT` is empty in the logs, the ARN was not passed correctly. Verify the CDK context value or SSM parameter.

### Test a voice session

1. Log in as a student in the frontend.
2. Navigate to a patient with voice enabled.
3. Start a new chat.
4. Speak into the microphone and verify you receive audio responses.

---

## 8. Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Runtime stays in "Creating" state | Container fails health check (`/ping` not responding on port 8080) | Check the AgentCore runtime logs. Verify the container image is correct and the port is 8080. |
| Socket server logs "Failed to connect to voice agent" | ARN is wrong, runtime is not active, or IAM permissions are missing | Verify the ARN matches the runtime. Check that the ECS task role has `bedrock-agentcore:InvokeAgentRuntime*` permissions. |
| `SignatureDoesNotMatch` errors | Region mismatch between the socket server and the AgentCore endpoint | The socket server signs requests using `AWS_REGION`. Ensure this matches the region where the AgentCore runtime was created. |
| Voice agent can't reach RDS Proxy | Wrong subnet selection or missing security group rules | Confirm the AgentCore runtime is in **private subnets** (not isolated). Verify the security group allows outbound on port 5432 to the RDS Proxy security group. |
| Voice agent can't reach Bedrock | No outbound internet from the subnet | Private subnets need a NAT Gateway for outbound internet. Isolated subnets have no internet access. Verify the subnet route table has a route to the NAT Gateway. |
| `No AWS credentials found via boto3` in agent logs | AgentCore execution role missing permissions | The agent uses boto3 to get credentials from the execution role. Verify the role has the required policies (see [Section 4.10](#410-add-iam-permissions-to-the-service-role)). |
| Audio works but no text transcriptions appear | Nova Sonic streaming issue or message persistence failure | Check the voice agent CloudWatch logs for errors in `_process_responses()` or `save_message_to_db()`. |
| Voice agent behavior not updating after code changes | AgentCore is still running the old container image | Follow the steps in [Section 6](#6-updating-the-voice-agent-after-code-changes) to update the hosting with the latest ECR image. |

---

*This document covers the console-side setup only. For CI/CD pipeline configuration (ECR image builds), see the CICD stack in `cdk/lib/cicd-stack.ts`. For the voice agent application code, see `cdk/voice-agent/bot.py` and `cdk/voice-agent/nova_sonic.py`.*
