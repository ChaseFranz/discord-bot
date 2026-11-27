import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CfnOutput, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

/** The bot's permissions, kept as plain IAM JSON so it can be read and reviewed on its own. */
export const BOT_POLICY_FILE = join(__dirname, '..', 'nimbus-bot-policy.json');

/** Secrets Manager secret holding the bot's access key ({"accessKeyId", "secretAccessKey"}). */
export const CREDENTIALS_SECRET_NAME = 'nimbus/bot-access-key';

export interface NimbusStackProps extends StackProps {
  /** Increase to rotate the bot's access key on the next deploy (the old key is deleted). */
  readonly accessKeySerial?: number;
}

/**
 * AWS resources for running Nimbus outside AWS (on a PC): a least-privilege IAM user whose access
 * key is stored in Secrets Manager, never in stack outputs.
 *
 * When the bot moves onto AWS compute, attach `policy` to that compute's role and remove the user
 * and key: roles get temporary credentials automatically, so no long-lived key is needed there.
 */
export class NimbusStack extends Stack {
  readonly policy: iam.ManagedPolicy;
  readonly user: iam.User;
  readonly credentials: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: NimbusStackProps = {}) {
    super(scope, id, props);

    this.policy = new iam.ManagedPolicy(this, 'BotPolicy', {
      managedPolicyName: 'NimbusBot',
      description: 'Nimbus Discord bot: Transcribe, Polly and Claude Platform on AWS',
      document: iam.PolicyDocument.fromJson(JSON.parse(readFileSync(BOT_POLICY_FILE, 'utf8'))),
    });

    this.user = new iam.User(this, 'BotUser', {
      userName: 'nimbus-bot',
      managedPolicies: [this.policy],
    });

    const accessKey = new iam.AccessKey(this, 'BotAccessKey', {
      user: this.user,
      serial: props.accessKeySerial,
    });

    this.credentials = new secretsmanager.Secret(this, 'BotCredentials', {
      secretName: CREDENTIALS_SECRET_NAME,
      description: 'Access key for the nimbus-bot IAM user. Write it into the bot .env with infra/scripts/write-bot-credentials.mjs.',
      secretObjectValue: {
        accessKeyId: SecretValue.unsafePlainText(accessKey.accessKeyId),
        secretAccessKey: accessKey.secretAccessKey,
      },
    });

    new CfnOutput(this, 'BotUserName', { value: this.user.userName });
    new CfnOutput(this, 'BotPolicyArn', { value: this.policy.managedPolicyArn });
    new CfnOutput(this, 'BotCredentialsSecretName', { value: CREDENTIALS_SECRET_NAME });
  }
}
