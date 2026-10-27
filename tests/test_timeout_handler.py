"""
Ingestion timeout handler (cdk/lambda/timeoutHandler/timeoutHandler.py).

  - only the configured timeout alarm entering ALARM triggers the sweep; other
    alarms, OK transitions and malformed events are ignored with no DB access
  - the sweep is a single UPDATE limited to rows in 'processing' for at least
    STUCK_AFTER_SECONDS, parameterized rather than interpolated

boto3, psycopg2 and aws_lambda_powertools are stubbed.
"""
import importlib.util
import json
import logging
import os
import sys
import types

import pytest

_HANDLER = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "cdk", "lambda", "timeoutHandler", "timeoutHandler.py",
)
ALARM_NAME = "PIPT-Api-DataIngestLambdaTimeoutAlarm-ABC123"


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn

    def execute(self, sql, params=None):
        self.conn.executed.append((sql, params))

    def fetchall(self):
        return [("stuck.pdf",)]

    def close(self):
        pass


class FakeConnection:
    closed = False

    def __init__(self):
        self.executed = []
        self.commits = 0

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass


@pytest.fixture
def handler(monkeypatch):
    monkeypatch.setenv("SM_DB_CREDENTIALS", "secret")
    monkeypatch.setenv("RDS_PROXY_ENDPOINT", "proxy")
    monkeypatch.setenv("TIMEOUT_ALARM_NAME", ALARM_NAME)
    monkeypatch.setenv("STUCK_AFTER_SECONDS", "840")

    secret = {"dbname": "db", "username": "u", "password": "p", "port": 5432}
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda *_a, **_k: types.SimpleNamespace(
        get_secret_value=lambda SecretId: {"SecretString": json.dumps(secret)}
    )
    conn = FakeConnection()
    psycopg2 = types.ModuleType("psycopg2")
    psycopg2.connect = lambda *_a, **_k: conn
    powertools = types.ModuleType("aws_lambda_powertools")
    powertools.Logger = lambda *_a, **_k: logging.getLogger("timeoutHandler-test")
    for name, mod in (("boto3", boto3), ("psycopg2", psycopg2), ("aws_lambda_powertools", powertools)):
        monkeypatch.setitem(sys.modules, name, mod)

    spec = importlib.util.spec_from_file_location("timeoutHandler_under_test", _HANDLER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module._fake_conn = conn
    return module


def alarm_event(name=ALARM_NAME, state="ALARM"):
    return {
        "source": "aws.cloudwatch",
        "detail-type": "CloudWatch Alarm State Change",
        "resources": [f"arn:aws:cloudwatch:ca-central-1:123456789012:alarm:{name}"],
        "detail": {"alarmName": name, "state": {"value": state}},
    }


def test_timeout_alarm_runs_age_scoped_update(handler):
    result = handler.lambda_handler(alarm_event(), None)

    assert result["statusCode"] == 200
    conn = handler._fake_conn
    assert conn.commits == 1
    assert len(conn.executed) == 1
    sql, params = conn.executed[0]
    normalized = " ".join(sql.split())
    assert "WHERE ingestion_status = 'processing'" in normalized
    assert "time_uploaded < (now() AT TIME ZONE 'UTC') - make_interval(secs => %s)" in normalized
    assert params == (840,)


@pytest.mark.parametrize(
    "event",
    [
        alarm_event(name="PIPT-Api-CloudFrontHighRequests"),
        alarm_event(name="PIPT-Api-BedrockInvocationSpike"),
        alarm_event(state="OK"),
        alarm_event(state="INSUFFICIENT_DATA"),
        {**alarm_event(), "source": "custom.attacker"},
        {"detail": "not-a-dict"},
        {},
        None,
        "string",
    ],
)
def test_other_events_are_ignored_without_db_access(handler, event):
    result = handler.lambda_handler(event, None)

    assert result["statusCode"] == 200
    assert "Ignored" in result["body"]
    assert handler._fake_conn.executed == []
    assert handler._fake_conn.commits == 0
