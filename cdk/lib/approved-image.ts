import * as cdk from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { getImageTagSsmParam, IMAGE_TAG_PLACEHOLDER } from "./cicd-stack";

export interface ApprovedImageTagProps {
  /** Service token of the ECR image waiter provider (ApiServiceStack.imageWaiterServiceToken). */
  readonly serviceToken: string;
  readonly repository: ecr.IRepository;
  readonly stackPrefix: string;
  /** CI/CD module name, e.g. "textGeneration". */
  readonly moduleName: string;
  /** Build to start if no approved image exists yet. */
  readonly buildProjectName?: string;
}

/**
 * Returns the tag of the newest image of `moduleName` that passed the CI/CD
 * vulnerability gate, for pinning a Lambda function or ECS container to it.
 *
 * The tag comes from the SSM parameter the build writes (resolved when the
 * stack deploys), so `cdk deploy` keeps whatever the pipeline last shipped
 * instead of reverting it. Tags are immutable, so the reference can't be
 * repointed to a different image. The value is passed through the ECR image
 * waiter custom resource, which blocks until that image exists: on a fresh
 * environment it starts the build and waits for its first approved tag, and
 * on an environment that predates the parameter it falls back to the existing
 * `latest` image (which the old build only pushed after the scan gate).
 */
export function approvedImageTag(
  scope: Construct,
  id: string,
  props: ApprovedImageTagProps
): string {
  const parameterName = getImageTagSsmParam(props.stackPrefix, props.moduleName);
  const waiter = new cdk.CustomResource(scope, id, {
    serviceToken: props.serviceToken,
    properties: {
      RepositoryName: props.repository.repositoryName,
      // A new value here (the build shipped a new image) re-runs the waiter,
      // which updates the tag the consumer is pinned to.
      ImageTag: ssm.StringParameter.valueForStringParameter(scope, parameterName),
      ImageTagParameterName: parameterName,
      PlaceholderTag: IMAGE_TAG_PLACEHOLDER,
      FallbackTag: "latest",
      MaxRetries: "28",
      RetryDelaySeconds: "30",
      TriggerBuildOnMissing: props.buildProjectName ? "true" : "false",
      CodeBuildProjectName: props.buildProjectName ?? "",
    },
  });
  return waiter.getAttString("ImageTag");
}
