/**
 * AppSync text stream authorization (finding f-dbe2bb23):
 *   - publishTextStream is IAM-only, so end users cannot inject frames
 *   - onTextStream is Cognito-only and has an ownership-checking resolver, so
 *     a user cannot subscribe to another student's chat
 *   - the text-gen Lambda may call only the publish mutation field
 */

import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Template } from 'aws-cdk-lib/assertions';

const libDir = path.join(__dirname, '..', 'lib');
const schema = fs.readFileSync(path.join(libDir, 'schema.graphql'), 'utf8');
const stack = fs.readFileSync(path.join(libDir, 'api-service-stack.ts'), 'utf8');

/** Directives on a schema field declaration, which may span two lines. */
function fieldDirectives(field: string): string[] {
  const match = schema.match(new RegExp(`\\b${field}\\([^)]*\\)\\s*:\\s*\\w+!?([^\\n]*\\n?[^\\n]*)`));
  if (!match) throw new Error(`field ${field} not found in schema.graphql`);
  const tail = match[1].split(/\n\s*(?:#|type |\w+\()/)[0];
  return tail.match(/@\w+/g) ?? [];
}

function block(startMarker: string, endMarker: string): string {
  const start = stack.indexOf(startMarker);
  const end = stack.indexOf(endMarker, start);
  if (start === -1 || end === -1) throw new Error(`block ${startMarker} not found`);
  return stack.slice(start, end);
}

describe('schema.graphql auth directives', () => {
  test('publishTextStream is IAM-only', () => {
    const directives = fieldDirectives('publishTextStream');
    expect(directives).toContain('@aws_iam');
    expect(directives).not.toContain('@aws_cognito_user_pools');
  });

  test('onTextStream is Cognito-only (no IAM subscribers)', () => {
    const directives = fieldDirectives('onTextStream');
    expect(directives).toContain('@aws_cognito_user_pools');
    expect(directives).not.toContain('@aws_iam');
  });

  test('onTextStream still requires a sessionId filter', () => {
    expect(schema).toMatch(/onTextStream\(sessionId:\s*String!\)/);
  });

  test('TextStreamData is readable by the IAM publisher and the Cognito subscriber', () => {
    expect(schema).toMatch(/type TextStreamData @aws_iam @aws_cognito_user_pools/);
  });
});

describe('onTextStream resolver', () => {
  const resolver = block('createResolver("OnTextStreamAuthzResolver"', '});');

  test('is attached to Subscription.onTextStream on the Lambda data source', () => {
    expect(stack).toMatch(/textStreamAuthzDataSource\.createResolver\("OnTextStreamAuthzResolver"/);
    expect(resolver).toContain('typeName: "Subscription"');
    expect(resolver).toContain('fieldName: "onTextStream"');
  });

  test('passes the verified email claim and requested sessionId', () => {
    expect(resolver).toContain('$util.toJson($ctx.args.sessionId)');
    expect(resolver).toContain('$util.toJson($ctx.identity.claims.email)');
  });

  test('rejects callers without claims and fails closed on the Lambda result', () => {
    expect(resolver).toMatch(/isNullOrEmpty\(\$ctx\.identity\.claims\.email\)\)\s*\$util\.unauthorized\(\)/);
    expect(resolver).toMatch(/#if\(\$ctx\.error \|\| \$util\.isNull\(\$ctx\.result\) \|\| \$ctx\.result\.authorized != true\)\s*\$util\.unauthorized\(\)/);
  });

  test('the authz Lambda runs on its own role with only the app_rw secret', () => {
    const fn = block('const textStreamAuthzFunction = new lambda.Function(', '// addLambdaDataSource creates');
    expect(fn).toContain('handler: "textStreamAuthzFunction.handler"');
    expect(fn).toContain('role: textStreamAuthzRole');
    expect(fn).toMatch(/SM_DB_CREDENTIALS:\s*db\.secretPathUser\.secretName/);
    const role = block('const textStreamAuthzRole = new iam.Role(', 'const textStreamAuthzFunction');
    expect(role).toMatch(/actions:\s*\["secretsmanager:GetSecretValue"\],\s*resources:\s*\[db\.secretPathUser\.secretArn\]/);
  });
});

describe('text-gen Lambda AppSync grant', () => {
  const grant = block('// AppSync: the text-gen Lambda signs publishTextStream', '// Wire up the student function');

  test('is limited to the publishTextStream mutation field', () => {
    expect(grant).toMatch(/actions:\s*\["appsync:GraphQL"\]/);
    expect(grant).toContain('this.appSyncApi.arn + "/types/Mutation/fields/publishTextStream"');
    expect(grant).not.toContain('this.appSyncApi.arn + "/*"');
    expect(grant).not.toContain('GetGraphqlApi');
    expect(grant).not.toContain('ListGraphqlApis');
  });
});

describe('schema.graphql is accepted by AppSync L2 synthesis', () => {
  test('synthesizes the schema and the subscription resolver', () => {
    const app = new cdk.App();
    const s = new cdk.Stack(app, 'SchemaCheck');
    const userPool = new cognito.UserPool(s, 'Pool');
    const api = new appsync.GraphqlApi(s, 'Api', {
      name: 'schema-check',
      definition: appsync.Definition.fromFile(path.join(libDir, 'schema.graphql')),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: { userPool },
        },
        additionalAuthorizationModes: [{ authorizationType: appsync.AuthorizationType.IAM }],
      },
    });
    api.addNoneDataSource('None').createResolver('Sub', {
      typeName: 'Subscription',
      fieldName: 'onTextStream',
      requestMappingTemplate: appsync.MappingTemplate.fromString('{"version":"2018-05-29","payload":{}}'),
      responseMappingTemplate: appsync.MappingTemplate.fromString('$util.toJson(null)'),
    });
    const template = Template.fromStack(s);
    template.hasResourceProperties('AWS::AppSync::Resolver', {
      TypeName: 'Subscription',
      FieldName: 'onTextStream',
    });
    template.resourceCountIs('AWS::AppSync::GraphQLSchema', 1);
  });
});
