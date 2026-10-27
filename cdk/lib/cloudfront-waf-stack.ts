import * as cdk from "aws-cdk-lib";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
import { LogProtection, logWebAclToCloudWatch } from "./log-protection";

/**
 * CloudFront WAF stack — must be deployed in us-east-1.
 * CloudFront distributions can only use WAFs in us-east-1.
 */
export class CloudFrontWafStack extends cdk.Stack {
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const webAcl = new wafv2.CfnWebACL(this, `${id}-CloudFrontWaf`, {
      description: "WAF for CloudFront document delivery",
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `${id}-CloudFrontWaf`,
      },
      rules: [
        {
          name: "AWS-AWSManagedRulesCommonRuleSet",
          priority: 1,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "CloudFront-AWSManagedRulesCommonRuleSet",
          },
        },
        {
          name: "RateLimitRequests2000",
          priority: 2,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: "IP",
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "CloudFront-RateLimitRequests2000",
          },
        },
        {
          name: "AWS-AWSManagedRulesKnownBadInputsRuleSet",
          priority: 3,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesKnownBadInputsRuleSet",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "CloudFront-AWSManagedRulesKnownBadInputsRuleSet",
          },
        },
        {
          name: "AWS-AWSManagedRulesAmazonIpReputationList",
          priority: 4,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesAmazonIpReputationList",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "CloudFront-AWSManagedRulesAmazonIpReputationList",
          },
        },
        {
          name: "AWS-AWSManagedRulesSQLiRuleSet",
          priority: 5,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesSQLiRuleSet",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "CloudFront-AWSManagedRulesSQLiRuleSet",
          },
        },
      ],
    });

    this.webAclArn = webAcl.attrArn;

    // Full request log for the CloudFront web ACL. CLOUDFRONT-scope WAF logs
    // must go to us-east-1, which is where this stack is deployed.
    const logProtection = new LogProtection(this, `${id}-LogProtection`);
    logWebAclToCloudWatch(
      this,
      `${id}-WafLogging`,
      webAcl,
      `aws-waf-logs-${id}`,
      logProtection
    );

    new cdk.CfnOutput(this, "CloudFrontWafArn", {
      value: webAcl.attrArn,
      description: "WAF Web ACL ARN for CloudFront distribution",
      exportName: `${id}-WafArn`,
    });
  }
}
