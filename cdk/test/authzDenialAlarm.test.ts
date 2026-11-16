/**
 * The AUTHZ_DENY metric filter must use a text pattern: Lambda's default text
 * log format prefixes every line with timestamp, request ID and level, so a
 * JSON pattern ($.message = ...) never matches and the IDOR alarm can't fire.
 * Also pins the log retention chosen in cdk.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as logs from 'aws-cdk-lib/aws-logs';

const stackSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api-service-stack.ts'), 'utf8');

function authzFilterBlock(): string {
  const start = stackSrc.indexOf('`${id}-${name}AuthzDenyMetricFilter`');
  expect(start).toBeGreaterThan(-1);
  return stackSrc.slice(start, stackSrc.indexOf('});', start));
}

describe('authorization denial metric filter', () => {
  test('uses a quoted text pattern, not a JSON pattern', () => {
    const block = authzFilterBlock();
    expect(block).toContain(`logs.FilterPattern.literal('"AUTHZ_DENY"')`);
    expect(block).not.toMatch(/FilterPattern\.(stringValue|numberValue|all|any)\(/);
  });

  test('the pattern appears in a runtime-prefixed denial line', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const logger = require('../lambda/lib/logger.js');
      logger.warn('AUTHZ_DENY', { check: 'verifySessionOwnership', reason: 'not_authorized' });
      const [line] = errorSpy.mock.calls[0];
      // What CloudWatch stores for a text-format Node.js Lambda.
      const event = `2026-11-16T16:27:15.536Z\t0b1c2d3e-request\tWARN\t${line}`;
      // A quoted term matches that exact phrase anywhere in the event.
      const phrase = JSON.parse(logs.FilterPattern.literal('"AUTHZ_DENY"').logPatternString);
      expect(event).toContain(phrase);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test('the alarm reads the same metric the filters write', () => {
    expect(stackSrc).toContain('metricName: authzDenialMetricName');
    expect(stackSrc).toMatch(/AuthzDenialSpikeAlarm[\s\S]*metricName: authzDenialMetricName/);
  });
});

describe('log retention', () => {
  test('cdk.json sets a 3-day retention', () => {
    const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
    expect(cdkJson.context.LogRetentionDays).toBe(3);
  });
});
