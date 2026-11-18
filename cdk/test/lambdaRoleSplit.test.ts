/**
 * Least privilege for API Lambda and ECS socket roles.
 *
 * The student, instructor, authorizer and timeout-handler Lambdas used to share
 * one role, so each held the union of all permissions (e.g. the student
 * authorizer could read the app_rw DB credential). The ECS socket task role was
 * also reused as the execution role. These tests keep the roles split.
 */

import * as fs from 'fs';
import * as path from 'path';

const read = (file: string) => fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8');
const apiSrc = read('api-service-stack.ts');
const ecsSrc = read('ecs-socket-stack.ts');

/** Source of the call that starts at `marker`, parens balanced. */
function callAt(src: string, marker: string): string {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`not found: ${marker}`);
  const open = src.indexOf('(', start);
  let depth = 0;
  let end = open;
  for (; end < src.length; end++) {
    if (src[end] === '(') depth++;
    else if (src[end] === ')' && --depth === 0) break;
  }
  return src.slice(start, end + 1);
}

const fnRole = (constName: string) => {
  const match = callAt(apiSrc, `const ${constName} = new lambda.Function`).match(/\brole:\s*(\w+)/);
  return match?.[1];
};

describe('API Lambda roles are split by trust boundary', () => {
  test('the shared postgresLambdaRole is gone', () => {
    expect(apiSrc).not.toMatch(/\blambdaRole\b/);
    expect(apiSrc).not.toContain('postgresLambdaRole');
  });

  test.each([
    ['lambdaStudentFunction', 'studentLambdaRole'],
    ['lambdaInstructorFunction', 'instructorLambdaRole'],
    ['authorizationFunction_student', 'studentAuthorizerRole'],
    ['authorizationFunction_instructor', 'roleAuthorizerRole'],
    ['authorizationFunction', 'roleAuthorizerRole'],
    ['timeoutHandlerLambda', 'timeoutHandlerRole'],
    ['lambdaAdminFunction', 'adminLambdaRole'],
  ])('%s runs as %s', (fn, role) => {
    expect(fnRole(fn)).toBe(role);
  });

  test('the student authorizer role has logs only: no DB secret, RDS or ENI access', () => {
    const def = callAt(apiSrc, 'const studentAuthorizerRole = newApiLambdaRole');
    expect(def).toMatch(/\[\s*lambdaLogsPolicy\s*\]/);
    expect(def).not.toContain('appRwDbAccessPolicy');
    expect(def).not.toContain('lambdaVpcEniPolicy');
    expect(apiSrc).not.toMatch(/studentAuthorizerRole\.(addToPolicy|addManagedPolicy|attachInlinePolicy)/);
  });

  test('the student authorizer is configured without DB access', () => {
    const fn = callAt(apiSrc, 'const authorizationFunction_student = new lambda.Function');
    expect(fn).not.toContain('SM_DB_CREDENTIALS');
    expect(fn).not.toMatch(/^\s*REQUIRED_ROLES\s*:/m);
    expect(fn).not.toMatch(/\bvpc:/);
  });

  test('the app_rw policy grants only the app_rw secret, never app_tc', () => {
    const policy = callAt(apiSrc, 'const appRwDbAccessPolicy = new iam.ManagedPolicy');
    expect(policy).toContain('db.secretPathUser.secretArn');
    expect(policy).not.toContain('secretPathTableCreator');
  });
});

describe('ECS socket task and execution roles are separate', () => {
  const taskDef = callAt(ecsSrc, 'const taskDef = new ecs.FargateTaskDefinition');

  test('the task definition uses a dedicated execution role', () => {
    expect(taskDef).not.toMatch(/executionRole:\s*taskRole/);
    expect(taskDef).toMatch(/\bexecutionRole\b/);
  });

  test('the execution role has no inline or managed policies of its own', () => {
    const def = callAt(ecsSrc, 'const executionRole = new iam.Role');
    expect(def).not.toContain('inlinePolicies');
    expect(def).not.toContain('managedPolicies');
    expect(ecsSrc).not.toMatch(/executionRole\.(addToPolicy|addManagedPolicy)/);
  });

  test('the task role no longer carries the ECS execution managed policy', () => {
    expect(callAt(ecsSrc, 'const taskRole = new iam.Role')).not.toContain(
      'AmazonECSTaskExecutionRolePolicy'
    );
  });

  test('the CI/CD redeploy can pass both roles', () => {
    expect(ecsSrc).toMatch(
      /actions:\s*\["iam:PassRole"\][\s\S]*?resources:\s*\[taskRole\.roleArn,\s*executionRole\.roleArn\]/
    );
  });
});
