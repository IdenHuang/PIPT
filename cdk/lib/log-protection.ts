import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

/**
 * CloudWatch log protection shared by the stacks: a finite retention period
 * and a customer-managed KMS key for log groups.
 *
 * Retention is set with the `LogRetentionDays` context value (default 365).
 * It must be one of the values CloudWatch Logs accepts (1, 3, 5, 7, 14, 30,
 * 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922,
 * 3288, 3653). Infinite retention is rejected.
 *
 * https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/encrypt-log-data-kms.html
 */
export const DEFAULT_LOG_RETENTION_DAYS = 365;

const VALID_RETENTION_DAYS = new Set<number>(
  Object.values(logs.RetentionDays).filter(
    (v): v is number => typeof v === "number" && v !== logs.RetentionDays.INFINITE
  )
);

/** Resolves the `LogRetentionDays` context value, failing synth on invalid input. */
export function resolveLogRetention(scope: Construct): logs.RetentionDays {
  const raw = scope.node.tryGetContext("LogRetentionDays");
  const days =
    raw === undefined || raw === null || raw === "" ? DEFAULT_LOG_RETENTION_DAYS : Number(raw);
  if (!VALID_RETENTION_DAYS.has(days)) {
    throw new Error(
      `Invalid LogRetentionDays context value "${raw}". Use one of: ${[...VALID_RETENTION_DAYS]
        .sort((a, b) => a - b)
        .join(", ")}.`
    );
  }
  return days as logs.RetentionDays;
}

export class LogProtection extends Construct {
  public readonly retention: logs.RetentionDays;
  public readonly encryptionKey: kms.Key;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.retention = resolveLogRetention(this);
    this.encryptionKey = this.createEncryptionKey();
  }

  /**
   * Creates a KMS-encrypted log group for a Lambda function, to be passed as
   * the function's `logGroup` prop. Named `/aws/lambda/<functionName>/encrypted`
   * because the function's original `/aws/lambda/<functionName>` group already
   * exists outside CloudFormation and cannot be re-created or imported.
   */
  public lambdaLogGroup(functionName: string): logs.LogGroup {
    return new logs.LogGroup(this, `${functionName}-LogGroup`, {
      logGroupName: `/aws/lambda/${functionName}/encrypted`,
      retention: this.retention,
      encryptionKey: this.encryptionKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }

  /**
   * Applies the retention period to each function's original, unencrypted
   * `/aws/lambda/<functionName>` group so the data already written there
   * (which may contain tokens and student content) ages out instead of being
   * kept forever.
   *
   * The construct is created at `<function>/LogRetention`, the same path the
   * deprecated `logRetention` function prop used, so functions that had that
   * prop keep their existing custom resource and only its retention changes.
   */
  public expireLegacyLambdaLogGroups(functions: lambda.Function[]): void {
    for (const fn of functions) {
      new logs.LogRetention(fn, "LogRetention", {
        logGroupName: `/aws/lambda/${fn.functionName}`,
        retention: this.retention,
      });
    }
  }

  protected createEncryptionKey(): kms.Key {
    const stack = cdk.Stack.of(this);
    const key = new kms.Key(this, "LogEncryptionKey", {
      description: `Encrypts CloudWatch log groups for ${stack.stackName}`,
      enableKeyRotation: true,
      // Retained so log data encrypted with it stays readable after stack deletion.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // CloudWatch Logs may use the key only for log groups in this account and region.
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowCloudWatchLogsUse",
        principals: [new iam.ServicePrincipal(`logs.${stack.region}.amazonaws.com`)],
        actions: [
          "kms:Encrypt*",
          "kms:Decrypt*",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:Describe*",
        ],
        resources: ["*"],
        conditions: {
          ArnLike: {
            "kms:EncryptionContext:aws:logs:arn": `arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:*`,
          },
        },
      })
    );
    return key;
  }
}

/**
 * Sends every request a WAF web ACL evaluates to an encrypted CloudWatch log
 * group with finite retention.
 *
 * The authorization and cookie headers and the query string are redacted:
 * they carry bearer tokens, signed-URL signatures and access codes. WAF
 * creates the log group resource policy for log delivery itself.
 * https://docs.aws.amazon.com/waf/latest/developerguide/logging-cw-logs.html
 *
 * @param logGroupName - Must start with "aws-waf-logs-" (a WAF requirement)
 */
export function logWebAclToCloudWatch(
  scope: Construct,
  id: string,
  webAcl: wafv2.CfnWebACL,
  logGroupName: string,
  logProtection: LogProtection
): wafv2.CfnLoggingConfiguration {
  if (!logGroupName.startsWith("aws-waf-logs-")) {
    throw new Error(`WAF log group name must start with "aws-waf-logs-": ${logGroupName}`);
  }
  const logGroup = new logs.LogGroup(scope, `${id}-LogGroup`, {
    logGroupName,
    retention: logProtection.retention,
    encryptionKey: logProtection.encryptionKey,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  // WAF rejects the ":*"-suffixed ARN that logGroup.logGroupArn returns.
  const logGroupArn = cdk.Stack.of(scope).formatArn({
    service: "logs",
    resource: "log-group",
    resourceName: logGroup.logGroupName,
    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
  });
  return new wafv2.CfnLoggingConfiguration(scope, id, {
    resourceArn: webAcl.attrArn,
    logDestinationConfigs: [logGroupArn],
    redactedFields: [
      { singleHeader: { Name: "authorization" } },
      { singleHeader: { Name: "cookie" } },
      { queryString: {} },
    ],
  });
}
