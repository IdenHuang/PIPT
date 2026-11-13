import boto3
import os
import time

dynamodb = boto3.client("dynamodb")

TABLE_NAME = os.environ["TABLE_NAME"]

# This Lambda is invoked as a CloudFormation custom resource during cdk deploy.
#
# Why is the table not owned by CDK?
#   The table was created manually in the AWS console before this CDK app existed.
#   At that point it already held live chat history data.
#   Handing ownership to CDK would require either destroying and recreating the table
#   (losing all data) or using `cdk import`, which we attempted but could not get to
#   work reliably. So CDK references the table by name rather than managing it.
#
# Why not `new dynamodb.Table(...)`?
#   CloudFormation would try to CREATE a new table, fail with "Table already exists",
#   and roll back the entire stack.
#
# Why not just `Table.fromTableName(...)`?
#   That works for an existing environment but silently fails on a fresh deploy,
#   the stack deploys successfully but every Lambda that touches DynamoDB crashes
#   at runtime with ResourceNotFoundException, with no obvious error at deploy time.
#
# This approach: attempt CreateTable and swallow ResourceInUseException.
#   Existing deploy: table already exists, Lambda returns success immediately.
#   Fresh deploy: table is created with the correct schema before any Lambda needs it.
#   CDK never owns the table lifecycle, so cdk destroy won't wipe chat history.
#
# Point-in-time recovery: when the resource property PointInTimeRecovery is "true",
# Create and Update both enable it (an idempotent call), so existing tables get it on
# the next deploy. Delete never touches the table. A rollback sends Update with the
# old properties, which don't set the flag, so a rollback makes no change.


def _wait_for_active():
    for _ in range(30):
        resp = dynamodb.describe_table(TableName=TABLE_NAME)
        if resp["Table"]["TableStatus"] == "ACTIVE":
            return
        time.sleep(5)


def _enable_point_in_time_recovery():
    # https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_UpdateContinuousBackups.html
    dynamodb.update_continuous_backups(
        TableName=TABLE_NAME,
        PointInTimeRecoverySpecification={"PointInTimeRecoveryEnabled": True},
    )


def handler(event, context):
    request_type = event.get("RequestType")
    properties = event.get("ResourceProperties") or {}
    want_pitr = str(properties.get("PointInTimeRecovery", "")).lower() == "true"

    if request_type == "Delete":
        return {"PhysicalResourceId": TABLE_NAME}

    if request_type == "Create":
        try:
            dynamodb.create_table(
                TableName=TABLE_NAME,
                KeySchema=[{"AttributeName": "SessionId", "KeyType": "HASH"}],
                AttributeDefinitions=[{"AttributeName": "SessionId", "AttributeType": "S"}],
                BillingMode="PAY_PER_REQUEST",
            )

            # Wait for ACTIVE before enabling TTL
            _wait_for_active()

            dynamodb.update_time_to_live(
                TableName=TABLE_NAME,
                TimeToLiveSpecification={"Enabled": True, "AttributeName": "expireAt"},
            )

        except dynamodb.exceptions.ResourceInUseException:
            pass  # Table already exists — nothing to do

    if want_pitr:
        _wait_for_active()
        _enable_point_in_time_recovery()

    return {"PhysicalResourceId": TABLE_NAME}
