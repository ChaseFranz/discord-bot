import { App, Tags } from 'aws-cdk-lib';
import { NimbusStack } from '../lib/nimbus-stack';

const app = new App();
Tags.of(app).add('Project', 'nimbus');

// Deploys to the account and region of the profile you run `cdk deploy` with.
new NimbusStack(app, 'Nimbus', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  description: 'Nimbus Discord bot: IAM identity for running the bot outside AWS',
  accessKeySerial: 1,
});
