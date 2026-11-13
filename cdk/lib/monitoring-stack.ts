import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

/**
 * Name of the SNS topic every PIPT alarm notifies.
 * Other stacks build the ARN from this name instead of importing a
 * CloudFormation export, so they stay decoupled from this stack.
 */
export const getAlarmTopicName = (stackPrefix: string) => `${stackPrefix}-Alarms`;

/**
 * Returns the shared alarm topic for use in another stack of the same
 * account and region. The consuming stack must depend on MonitoringStack so
 * the topic exists before its alarms are created.
 */
export function importAlarmTopic(scope: Construct, stackPrefix: string): sns.ITopic {
  const stack = cdk.Stack.of(scope);
  const topicArn = stack.formatArn({
    service: "sns",
    resource: getAlarmTopicName(stackPrefix),
    arnFormat: cdk.ArnFormat.NO_RESOURCE_NAME,
  });
  return sns.Topic.fromTopicArn(scope, "AlarmTopic", topicArn);
}

/**
 * Sends every CloudWatch alarm defined in `scope` (including those created
 * by nested constructs) to the alarm topic. Call it at the end of a stack's
 * constructor, after all alarms exist, so alarms added later are covered
 * without wiring each one by hand.
 */
export function notifyOnAllAlarms(scope: Construct, topic: sns.ITopic): void {
  const action = new cloudwatchActions.SnsAction(topic);
  for (const child of scope.node.findAll()) {
    if (child instanceof cloudwatch.Alarm) {
      child.addAlarmAction(action);
    }
  }
}

/**
 * The SNS topic, encrypted with its own KMS key, that every alarm in the
 * Database, Api and EcsSocket stacks publishes to.
 *
 * The stack creates no subscriptions. Subscribe to the topic outside CDK
 * (SNS console or AWS Chatbot) if notifications should reach someone.
 */
export class MonitoringStack extends cdk.Stack {
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, stackPrefix: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.alarmTopic = new sns.Topic(this, "AlarmTopic", {
      topicName: getAlarmTopicName(stackPrefix),
      displayName: `${stackPrefix} alarms`,
      masterKey: this.createTopicKey(),
      enforceSSL: true,
    });

    new cdk.CfnOutput(this, "AlarmTopicArn", {
      value: this.alarmTopic.topicArn,
      description: "SNS topic that PIPT alarms publish to",
    });
  }

  /**
   * Customer-managed key for the topic. CloudWatch alarms cannot publish to a
   * topic encrypted with the AWS-managed aws/sns key, so CloudWatch is
   * granted use of this key.
   * https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html#alarm-sns-encryption
   */
  protected createTopicKey(): kms.Key {
    const key = new kms.Key(this, "AlarmTopicKey", {
      description: `Encrypts the ${this.stackName} alarm topic`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowCloudWatchAlarms",
        principals: [new iam.ServicePrincipal("cloudwatch.amazonaws.com")],
        actions: ["kms:Decrypt", "kms:GenerateDataKey*"],
        resources: ["*"],
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      })
    );
    return key;
  }
}
