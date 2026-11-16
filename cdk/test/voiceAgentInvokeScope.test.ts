/**
 * The socket task role may invoke only the PIPT voice agent runtime. A grant on
 * Resource "*" would let leaked task credentials open sessions on any AgentCore
 * runtime in the account.
 */
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ecs-socket-stack.ts'), 'utf8');

describe('AgentCore invoke scope', () => {
  const start = src.indexOf('"bedrock-agentcore:InvokeAgentRuntime"');
  const statement = src.slice(start, src.indexOf('}),', start));

  test('the invoke statement exists', () => {
    expect(start).toBeGreaterThan(-1);
  });

  test('is scoped to the voice agent runtime and its endpoints', () => {
    expect(statement).toMatch(
      /resources:\s*\[\s*resolvedVoiceAgentEndpoint,\s*`\$\{resolvedVoiceAgentEndpoint\}\/\*`\s*\]/
    );
    expect(statement).not.toMatch(/resources:\s*\[\s*["']\*["']\s*\]/);
  });
});
