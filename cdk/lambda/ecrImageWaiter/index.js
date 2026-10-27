const { ECRClient, DescribeImagesCommand } = require("@aws-sdk/client-ecr");
const {
  CodeBuildClient,
  StartBuildCommand,
} = require("@aws-sdk/client-codebuild");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

const ecr = new ECRClient({});
const codebuild = new CodeBuildClient({});
const ssm = new SSMClient({});

/**
 * onEvent handler for a CDK provider-framework custom resource
 * (aws-cdk-lib/custom-resources Provider). Waits for a Docker image to exist
 * in ECR so consumers (Lambda functions, ECS task definitions) aren't created
 * before the CI/CD pipeline has built it.
 *
 * The provider framework sends the CloudFormation response: this handler
 * returns { PhysicalResourceId, Data } on success and throws on failure.
 * See https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.custom_resources-readme.html#handling-lifecycle-events-onevent
 *
 * Properties:
 *   RepositoryName        ECR repository to look in.
 *   ImageTag              tag to wait for. CDK passes the value of the
 *                         ImageTagParameterName SSM parameter here.
 *   ImageTagParameterName (optional) SSM parameter the CI/CD build writes the
 *                         scan-approved tag to. While ImageTag equals
 *                         PlaceholderTag (no build has run yet), the parameter
 *                         is re-read on every attempt.
 *   PlaceholderTag        (optional) value meaning "no approved image yet".
 *   FallbackTag           (optional) existing tag to use while no approved
 *                         image is recorded. Used to migrate environments from
 *                         the old mutable `latest` tag, which the build only
 *                         pushed after the vulnerability gate passed.
 *   MaxRetries, RetryDelaySeconds, CodeBuildProjectName, TriggerBuildOnMissing
 *
 * Returns Data.ImageTag: the tag that was found. Consumers pin to it.
 */
exports.handler = async (event) => {
  console.log("Event:", JSON.stringify({ ...event, ResponseURL: "..." }, null, 2));

  const { RequestType, ResourceProperties, PhysicalResourceId } = event;
  const {
    RepositoryName,
    ImageTag,
    ImageTagParameterName,
    PlaceholderTag,
    FallbackTag,
    MaxRetries = "60",
    RetryDelaySeconds = "30",
    CodeBuildProjectName,
    TriggerBuildOnMissing = "false",
  } = ResourceProperties;

  if (RequestType === "Delete") {
    return { PhysicalResourceId };
  }

  const maxRetries = parseInt(MaxRetries, 10);
  const retryDelay = parseInt(RetryDelaySeconds, 10) * 1000;
  const physicalId =
    PhysicalResourceId || `ecr-image-waiter-${RepositoryName}`;
  const isPlaceholder = (tag) => !tag || (PlaceholderTag && tag === PlaceholderTag);

  console.log(
    `Waiting for image in ${RepositoryName} (tag: ${ImageTag}, param: ${ImageTagParameterName || "none"})`,
  );
  console.log(`Max retries: ${maxRetries}, retry delay: ${retryDelay}ms`);

  let buildTriggered = false;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const tag = await resolveTag();
    if (tag && (await imageExists(RepositoryName, tag))) {
      console.log(`Image found in ${RepositoryName} with tag ${tag}`);
      return {
        PhysicalResourceId: physicalId,
        Data: { RepositoryName, ImageTag: tag },
      };
    }

    console.log(
      `Image not available yet (attempt ${attempt}/${maxRetries}, tag: ${tag || "none"}).`,
    );

    // On first miss, optionally trigger a CodeBuild build
    if (
      !buildTriggered &&
      TriggerBuildOnMissing.toString().toLowerCase() === "true" &&
      CodeBuildProjectName
    ) {
      buildTriggered = true;
      try {
        console.log(`Starting CodeBuild project ${CodeBuildProjectName}...`);
        await codebuild.send(
          new StartBuildCommand({ projectName: CodeBuildProjectName }),
        );
      } catch (cbError) {
        console.error(`Failed to start CodeBuild project ${CodeBuildProjectName}:`, cbError);
      }
    }

    if (attempt < maxRetries) {
      await sleep(retryDelay);
    }
  }

  throw new Error(
    `Timeout: no approved image found in repository ${RepositoryName} after ${maxRetries} retries (${
      (maxRetries * retryDelay) / 1000 / 60
    } minutes)`,
  );

  // Tag to look for on this attempt, or undefined if none is known yet.
  async function resolveTag() {
    if (!isPlaceholder(ImageTag)) {
      return ImageTag;
    }
    if (ImageTagParameterName) {
      const current = await readParameter(ImageTagParameterName);
      if (!isPlaceholder(current)) {
        return current;
      }
    }
    if (FallbackTag && (await imageExists(RepositoryName, FallbackTag))) {
      console.log(`No approved tag recorded yet; using existing ${FallbackTag} image`);
      return FallbackTag;
    }
    return undefined;
  }
};

async function imageExists(repositoryName, imageTag) {
  try {
    const response = await ecr.send(
      new DescribeImagesCommand({
        repositoryName,
        imageIds: [{ imageTag }],
      }),
    );
    return Boolean(response.imageDetails && response.imageDetails.length > 0);
  } catch (error) {
    if (
      error.name === "ImageNotFoundException" ||
      error.name === "RepositoryNotFoundException"
    ) {
      return false;
    }
    throw error;
  }
}

async function readParameter(name) {
  try {
    const response = await ssm.send(new GetParameterCommand({ Name: name }));
    return response.Parameter && response.Parameter.Value;
  } catch (error) {
    if (error.name === "ParameterNotFound") {
      return undefined;
    }
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
