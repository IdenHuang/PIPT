#!/bin/bash
# Records a scan-approved image and deploys it by digest. Runs in CodeBuild
# post_build, only after cdk/scripts/ecr_scan_gate.sh has passed.
#
# 1. Resolves $REPOSITORY_URI:$IMAGE_TAG to its digest.
# 2. Writes $IMAGE_TAG to the $IMAGE_TAG_PARAM SSM parameter. CDK pins the
#    Lambda functions and ECS task definition to this tag, so a later
#    `cdk deploy` keeps the image this build shipped instead of rolling back.
# 3. If LAMBDA_FUNCTION_NAME is set: points that function at the digest,
#    publishes a version and moves the `live` alias (if one exists).
# 4. If ECS_CLUSTER_PARAM/ECS_SERVICE_PARAM are set: registers a copy of the
#    service's current task definition with this module's container image
#    replaced by the digest, and rolls the service onto it.
#
# Every failure exits non-zero and fails the build. Each deploy step prints the
# command that rolls back to the previous version.
#
# Required env: REPO_NAME, REPOSITORY_URI, IMAGE_TAG, IMAGE_TAG_PARAM
# Optional env: LAMBDA_FUNCTION_NAME, ECS_CLUSTER_PARAM, ECS_SERVICE_PARAM
set -euo pipefail

: "${REPO_NAME:?REPO_NAME is required}"
: "${REPOSITORY_URI:?REPOSITORY_URI is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
: "${IMAGE_TAG_PARAM:?IMAGE_TAG_PARAM is required}"
LAMBDA_FUNCTION_NAME="${LAMBDA_FUNCTION_NAME:-}"
ECS_CLUSTER_PARAM="${ECS_CLUSTER_PARAM:-}"
ECS_SERVICE_PARAM="${ECS_SERVICE_PARAM:-}"

# 1. Digest of the image that just passed the gate.
DIGEST="$(aws ecr describe-images \
  --repository-name "$REPO_NAME" \
  --image-ids "imageTag=$IMAGE_TAG" \
  --query "imageDetails[0].imageDigest" --output text)"
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "ERROR: unexpected digest for $IMAGE_TAG: '$DIGEST'" >&2; exit 1; }
IMAGE_REF="$REPOSITORY_URI@$DIGEST"
echo "Approved image: $REPOSITORY_URI:$IMAGE_TAG ($IMAGE_REF)"

# 2. Record the approved tag before deploying, so the next `cdk deploy`
#    converges on it even if a deploy step below fails.
aws ssm put-parameter --name "$IMAGE_TAG_PARAM" --value "$IMAGE_TAG" --type String --overwrite >/dev/null
echo "Recorded $IMAGE_TAG in $IMAGE_TAG_PARAM"

# 3. Lambda
if [ -n "$LAMBDA_FUNCTION_NAME" ]; then
  if ! aws lambda get-function --function-name "$LAMBDA_FUNCTION_NAME" >/dev/null 2>&1; then
    echo "Lambda function $LAMBDA_FUNCTION_NAME does not exist yet. Skipping update."
  else
    PREV_IMAGE="$(aws lambda get-function --function-name "$LAMBDA_FUNCTION_NAME" --query "Code.ImageUri" --output text)"
    echo "Updating $LAMBDA_FUNCTION_NAME from $PREV_IMAGE to $IMAGE_REF..."
    aws lambda update-function-code \
      --function-name "$LAMBDA_FUNCTION_NAME" \
      --image-uri "$IMAGE_REF" >/dev/null
    aws lambda wait function-updated --function-name "$LAMBDA_FUNCTION_NAME"
    echo "Rollback command if needed: aws lambda update-function-code --function-name $LAMBDA_FUNCTION_NAME --image-uri $PREV_IMAGE"

    NEW_VERSION="$(aws lambda publish-version \
      --function-name "$LAMBDA_FUNCTION_NAME" \
      --query "Version" --output text)"
    echo "Published version: $NEW_VERSION"

    if aws lambda get-alias --function-name "$LAMBDA_FUNCTION_NAME" --name live >/dev/null 2>&1; then
      PREV_VERSION="$(aws lambda get-alias \
        --function-name "$LAMBDA_FUNCTION_NAME" --name live \
        --query "FunctionVersion" --output text)"
      aws lambda update-alias \
        --function-name "$LAMBDA_FUNCTION_NAME" --name live \
        --function-version "$NEW_VERSION" >/dev/null
      echo "Moved live alias from $PREV_VERSION to $NEW_VERSION"
      echo "Rollback command if needed: aws lambda update-alias --function-name $LAMBDA_FUNCTION_NAME --name live --function-version $PREV_VERSION"
    else
      echo "No live alias found. Skipping alias update."
    fi
  fi
fi

# 4. ECS
if [ -n "$ECS_CLUSTER_PARAM" ] && [ -n "$ECS_SERVICE_PARAM" ]; then
  # Exact names come from SSM, written by the ECS stack that also grants this
  # role UpdateService on that one service.
  if ! CLUSTER="$(aws ssm get-parameter --name "$ECS_CLUSTER_PARAM" --query Parameter.Value --output text 2>/dev/null)" \
    || ! SERVICE="$(aws ssm get-parameter --name "$ECS_SERVICE_PARAM" --query Parameter.Value --output text 2>/dev/null)"; then
    echo "ECS service parameters not found (ECS stack not deployed yet?). Skipping redeploy."
    exit 0
  fi

  CURRENT_TD="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
    --query "services[0].taskDefinition" --output text)"
  [ -n "$CURRENT_TD" ] && [ "$CURRENT_TD" != "None" ] || { echo "ERROR: no task definition for $SERVICE" >&2; exit 1; }

  TD_FILE="$(mktemp)"
  NEW_TD_FILE="$(mktemp)"
  trap 'rm -f "$TD_FILE" "$NEW_TD_FILE"' EXIT
  aws ecs describe-task-definition --task-definition "$CURRENT_TD" --query taskDefinition --output json > "$TD_FILE"

  # Swap the image of this module's container(s), i.e. those pulling from
  # $REPOSITORY_URI by tag or digest, and drop the read-only fields that
  # register-task-definition rejects.
  jq --arg repo "$REPOSITORY_URI" --arg image "$IMAGE_REF" '
    (.containerDefinitions[]
      | select((.image | startswith($repo + ":")) or (.image | startswith($repo + "@")))
      | .image) = $image
    | del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
          .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)
  ' "$TD_FILE" > "$NEW_TD_FILE"
  jq -e --arg image "$IMAGE_REF" 'any(.containerDefinitions[]; .image == $image)' "$NEW_TD_FILE" >/dev/null \
    || { echo "ERROR: no container in $CURRENT_TD uses $REPOSITORY_URI" >&2; exit 1; }

  NEW_TD="$(aws ecs register-task-definition --cli-input-json "file://$NEW_TD_FILE" \
    --query "taskDefinition.taskDefinitionArn" --output text)"
  echo "Registered $NEW_TD"

  echo "Rolling $SERVICE in $CLUSTER from $CURRENT_TD to $NEW_TD..."
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
    --task-definition "$NEW_TD" --query "service.serviceName" --output text
  echo "Rollback command if needed: aws ecs update-service --cluster $CLUSTER --service $SERVICE --task-definition $CURRENT_TD"
  echo "Waiting for $SERVICE to stabilize..."
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
fi

if [ -z "$LAMBDA_FUNCTION_NAME" ] && { [ -z "$ECS_CLUSTER_PARAM" ] || [ -z "$ECS_SERVICE_PARAM" ]; }; then
  echo "No CDK-managed deployment target for this module. Point its runtime at:"
  echo "  $REPOSITORY_URI:$IMAGE_TAG"
fi
