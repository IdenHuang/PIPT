#!/bin/bash
set -e

# Determines whether a Docker build is needed based on changed files.
# Expects environment variables: REPO_NAME, PATH_FILTER, CODEBUILD_SRC_DIR,
# IMAGE_TAG_PARAM, IMAGE_TAG_PLACEHOLDER
# Exit 0 = build needed, Exit 1 = skip build

cd "$CODEBUILD_SRC_DIR"

# Build unconditionally until an approved image is recorded and still in ECR.
APPROVED_TAG=$(aws ssm get-parameter --name "$IMAGE_TAG_PARAM" --query Parameter.Value --output text 2>/dev/null || echo "")
if [ -z "$APPROVED_TAG" ] || [ "$APPROVED_TAG" = "$IMAGE_TAG_PLACEHOLDER" ] \
  || ! aws ecr describe-images --repository-name "$REPO_NAME" --image-ids "imageTag=$APPROVED_TAG" &>/dev/null; then
  echo "No approved image recorded yet - building without path check"
  exit 0
fi

# Initialize git if needed (CodePipeline source may not have .git)
if [ ! -d .git ]; then
  echo "No git history available - building to be safe"
  exit 0
fi

PREV_COMMIT=$(git rev-parse HEAD~1 || echo "")
if [ -z "$PREV_COMMIT" ]; then
  echo "First commit - building"
  exit 0
fi

CHANGED_FILES=$(git diff --name-only "$PREV_COMMIT" HEAD)
echo "Changed files:"
echo "$CHANGED_FILES"

if ! echo "$CHANGED_FILES" | grep -q "^$PATH_FILTER/"; then
  echo "No changes in $PATH_FILTER — skipping build."
  exit 1
fi

exit 0
