import { ArnFormat, CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { ANTHROPIC_KEY_SECRET_NAME, DISCORD_TOKEN_SECRET_NAME } from './nimbus-cloud-stack';

const GITHUB_ISSUER = 'token.actions.githubusercontent.com';

export interface NimbusDeployStackProps extends StackProps {
  /** "owner/repo" allowed to deploy. */
  repository: string;
  /** GitHub environment whose jobs may deploy (its protection rules, e.g. required reviewers, gate this). */
  environment: string;
  /** An existing GitHub OIDC provider in the account, if there is one (an account can only have one). */
  existingProviderArn?: string;
}

/**
 * What's set up once by hand, before GitHub Actions takes over:
 *  - the secrets (Discord token, Claude API key), so they can be filled in before the first
 *    deploy (`npm run aws:secrets`);
 *  - GitHub's way in without stored AWS keys: its OIDC token is exchanged for a role that only jobs
 *    in this repository's deploy environment can assume. The role can do no more than use the CDK
 *    bootstrap roles (which do the deploying) and read the Discord token, to register slash
 *    commands after a deploy.
 */
export class NimbusDeployStack extends Stack {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: NimbusDeployStackProps) {
    super(scope, id, props);

    for (const [id, secretName, description] of [
      ['DiscordToken', DISCORD_TOKEN_SECRET_NAME, 'Discord bot token for Nimbus. Set it with `npm run aws:secrets` (reads .env).'],
      ['AnthropicKey', ANTHROPIC_KEY_SECRET_NAME, 'Claude API key for Nimbus, used with CLAUDE_PROVIDER=anthropic. Set it with `npm run aws:secrets`.'],
    ] as const) {
      // Kept if the stack is deleted: the values are typed in by hand.
      new secretsmanager.Secret(this, id, { secretName, description }).applyRemovalPolicy(RemovalPolicy.RETAIN);
    }

    const providerArn =
      props.existingProviderArn ??
      new iam.CfnOIDCProvider(this, 'GitHubOidc', { url: `https://${GITHUB_ISSUER}`, clientIdList: ['sts.amazonaws.com'] }).attrArn;

    this.role = new iam.Role(this, 'DeployRole', {
      roleName: 'nimbus-github-deploy',
      description: `GitHub Actions deploys from ${props.repository} (${props.environment} environment)`,
      assumedBy: new iam.FederatedPrincipal(
        providerArn,
        {
          StringEquals: {
            [`${GITHUB_ISSUER}:aud`]: 'sts.amazonaws.com',
            [`${GITHUB_ISSUER}:sub`]: `repo:${props.repository}:environment:${props.environment}`,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${this.region}`],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [this.formatArn({ service: 'secretsmanager', resource: 'secret', resourceName: `${DISCORD_TOKEN_SECRET_NAME}-*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', {
      value: this.role.roleArn,
      description: 'Set this as the AWS_DEPLOY_ROLE_ARN variable of the GitHub production environment',
    });
  }
}
