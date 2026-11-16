/**
 * The socket NLB → ECS hop is plain HTTP on port 80, so who can reach it must
 * be as narrow as possible. Only CloudFront (origin-facing prefix list) and the
 * text-gen Lambda's own security group may reach the NLB, and only the NLB may
 * reach the ECS service. A VPC-CIDR rule would let any resource in the VPC
 * read or inject socket traffic, including /stream-callback.
 */
import * as fs from 'fs';
import * as path from 'path';

const libDir = path.join(__dirname, '..', 'lib');
const read = (file: string) => fs.readFileSync(path.join(libDir, file), 'utf8');

describe('Socket NLB and service ingress', () => {
  const socketSrc = read('ecs-socket-stack.ts');
  const apiSrc = read('api-service-stack.ts');

  test('no ingress rule in the socket stack is opened to the VPC CIDR', () => {
    expect(socketSrc).not.toMatch(/Peer\.ipv4\(\s*vpc\.vpcCidrBlock\s*\)/);
  });

  test('the NLB admits the CloudFront prefix list and the text-gen Lambda group only', () => {
    const rules = socketSrc.match(/nlbSg\.addIngressRule\(\s*([^,]+),/g) ?? [];
    const peers = rules.map((r) => r.replace(/nlbSg\.addIngressRule\(\s*/, '').replace(/,$/, '').trim());
    expect(peers).toEqual([
      'ec2.Peer.prefixList(cloudFrontOriginFacing.prefixListId)',
      'apiServiceStack.textGenLambdaSg',
    ]);
  });

  test('the ECS service admits traffic from the NLB security group only', () => {
    const allows = socketSrc.match(/service\.connections\.allowFrom\(\s*([^,]+),/g) ?? [];
    expect(allows).toHaveLength(1);
    expect(allows[0]).toMatch(/allowFrom\(\s*nlbSg,/);
  });

  test('textGenLambdaSg is attached to the text-gen Lambda and no other function', () => {
    const uses = apiSrc.match(/securityGroups:\s*\[[^\]]*this\.textGenLambdaSg[^\]]*\]/g) ?? [];
    expect(uses).toHaveLength(1);
    const textGenBlock = apiSrc.slice(apiSrc.indexOf('TextGenLambdaDockerFunction`,'));
    expect(textGenBlock.slice(0, 600)).toContain('securityGroups: [apiLambdaSg, this.textGenLambdaSg]');
  });
});
