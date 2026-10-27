import * as cdk from "aws-cdk-lib";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { resolveLogRetention } from "./log-protection";

/**
 * Optional account-level CloudTrail trail recording management events (IAM,
 * Cognito, Lambda, RDS, S3 configuration changes and so on) in every region.
 *
 * Deploy it only in accounts that have no trail already: AWS Control Tower and
 * AWS Organizations trails record the same events, and a second copy of
 * management events is billed. Enable with `-c EnableCloudTrail=true`.
 * https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-trail-pricing.html
 */
export class AuditTrailStack extends cdk.Stack {
  public readonly trail: cloudtrail.Trail;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const retention = resolveLogRetention(this);

    const trailBucket = new s3.Bucket(this, `${id}-TrailBucket`, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Versioning keeps the trail recoverable if an object is overwritten or deleted.
      versioned: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(retention),
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.trail = new cloudtrail.Trail(this, `${id}-Trail`, {
      trailName: `${id}-Trail`,
      bucket: trailBucket,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      // Digest files let you prove log files were not modified after delivery.
      enableFileValidation: true,
      managementEvents: cloudtrail.ReadWriteType.ALL,
    });
  }
}
