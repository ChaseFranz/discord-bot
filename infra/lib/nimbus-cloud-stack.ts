import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat, type NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { BOT_POLICY_FILE } from './nimbus-stack';

export const DISCORD_TOKEN_SECRET_NAME = 'nimbus/discord-bot-token';
export const ANTHROPIC_KEY_SECRET_NAME = 'nimbus/anthropic-api-key';
const SCHEDULE_GROUP = 'nimbus-reminders';

export type ClaudeAccessProps = { provider: 'aws'; workspaceId: string } | { provider: 'anthropic' };

export interface NimbusCloudStackProps extends StackProps {
  discord: {
    /** Application ID (also the bot's user ID). */
    clientId: string;
    /** The server the bot serves. */
    guildId: string;
    /** Public key from the Developer Portal, used to check that requests really come from Discord. */
    publicKey: string;
  };
  /** IANA time zone for reminders and the daily budget (AWS runs in UTC otherwise). */
  timeZone: string;
  claude: ClaudeAccessProps;
  /** Gets the cost and error alerts. */
  alertEmail?: string;
  /** AWS Budgets alert for the whole account, in USD per month. */
  monthlyBudgetUsd?: number;
  /**
   * Music from YouTube. YouTube won't hand audio to AWS addresses ("Sign in to confirm you're not a
   * bot"), so here it is fetched by music helpers: a small script people run on their own
   * computers (see helper/README.md). False turns music off altogether. Default true.
   */
  musicEnabled?: boolean;
  /** Other bot settings (the names in .env.example), e.g. { DAILY_BUDGET_USD: '5' }. */
  botSettings?: Record<string, string>;
  /** The repository root: the Dockerfile and the Lambda sources live there. */
  projectRoot: string;
}

/**
 * Nimbus on AWS, running only while it's used:
 *  - Discord sends slash commands to a Lambda function URL (`edge`), which answers "thinking…" and
 *    hands the work to `worker`.
 *  - Voice commands go to a Fargate task started on demand; it exits when the call ends.
 *  - Reminders wake the `reminders` Lambda through EventBridge Scheduler.
 *  - Everything is stored in two on-demand DynamoDB tables.
 * Nothing runs, and almost nothing is billed, while nobody is using the bot.
 */
export class NimbusCloudStack extends Stack {
  constructor(scope: Construct, id: string, props: NimbusCloudStackProps) {
    super(scope, id, props);

    // Storage ---------------------------------------------------------------------
    const table = new dynamodb.Table(this, 'Data', {
      tableName: 'nimbus',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    for (const index of ['gsi1', 'gsi2']) {
      table.addGlobalSecondaryIndex({
        indexName: index,
        partitionKey: { name: `${index}pk`, type: dynamodb.AttributeType.STRING },
        sortKey: { name: `${index}sk`, type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
    }
    // Long-term notes about people, in their own table (as memories.db is locally).
    const memories = new dynamodb.Table(this, 'Memories', {
      tableName: 'nimbus-memories',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Orders for the voice task: in order, deduplicated, and dropped after 15 minutes (an
    // interaction can't be answered after that anyway).
    const queue = new sqs.Queue(this, 'VoiceOrders', {
      queueName: 'nimbus-voice.fifo',
      fifo: true,
      retentionPeriod: Duration.minutes(15),
      visibilityTimeout: Duration.minutes(2),
    });

    // Secrets live in the NimbusDeploy stack (so they can be filled in before the first deploy).
    const discordToken = secretsmanager.Secret.fromSecretNameV2(this, 'DiscordToken', DISCORD_TOKEN_SECRET_NAME);
    const anthropicKey =
      props.claude.provider === 'anthropic' ? secretsmanager.Secret.fromSecretNameV2(this, 'AnthropicKey', ANTHROPIC_KEY_SECRET_NAME) : undefined;

    // Settings every bot process reads (see src/config/config.ts).
    const botEnvironment: Record<string, string> = {
      ...props.botSettings,
      MUSIC_ENABLED: String(props.musicEnabled ?? true),
      CLIENT_ID: props.discord.clientId,
      GUILD_ID: props.discord.guildId,
      TIMEZONE: props.timeZone,
      STORAGE: 'dynamodb',
      DYNAMODB_TABLE: table.tableName,
      DYNAMODB_MEMORY_TABLE: memories.tableName,
      CLAUDE_PROVIDER: props.claude.provider,
      ...(props.claude.provider === 'aws' ? { ANTHROPIC_AWS_WORKSPACE_ID: props.claude.workspaceId } : {}),
      VOICE_QUEUE_URL: queue.queueUrl,
    };

    // Policies the bot needs, from the same reviewed file the PC identity uses.
    const botPolicy = JSON.parse(readFileSync(BOT_POLICY_FILE, 'utf8')) as { Statement: Array<{ Action: string | string[] }> };
    const statements = (keep: (action: string) => boolean) =>
      botPolicy.Statement.filter((statement) => [statement.Action].flat().some(keep)).map((statement) => iam.PolicyStatement.fromJson(statement));
    const speech = statements((action) => action.startsWith('transcribe:') || action.startsWith('polly:'));
    const claude = props.claude.provider === 'aws' ? statements((action) => !action.startsWith('transcribe:') && !action.startsWith('polly:')) : [];

    // Network: public subnets only. The task gets a public IP to reach Discord (including voice
    // over UDP) and AWS, so there's no NAT gateway to pay for. Nothing can connect in.
    const vpc = new ec2.Vpc(this, 'Network', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }],
    });
    const taskSecurityGroup = new ec2.SecurityGroup(this, 'VoiceTaskSecurityGroup', {
      vpc,
      description: 'Nimbus voice task: outbound only',
      allowAllOutbound: true,
    });

    // Reminders --------------------------------------------------------------------
    const lambdaDefaults = (name: string): NodejsFunctionProps => ({
        functionName: name,
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        projectRoot: props.projectRoot,
        depsLockFilePath: join(props.projectRoot, 'package-lock.json'),
        logGroup: new logs.LogGroup(this, `${name}-logs`, {
          logGroupName: `/aws/lambda/${name}`,
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        environment: { NODE_OPTIONS: '--enable-source-maps' },
        bundling: {
          format: OutputFormat.ESM,
          target: 'node24',
          // Smaller bundles start faster; source maps keep stack traces readable.
          minify: true,
          sourceMap: true,
          mainFields: ['module', 'main'],
          // ESM bundles still meet CommonJS dependencies that call require().
          banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
          // Optional native add-ons of discord.js and the voice libraries; Lambda never handles audio.
          externalModules: ['zlib-sync', 'bufferutil', 'utf-8-validate', '@discordjs/opus', 'opusscript', 'sodium-native', 'libsodium-wrappers'],
        },
      });
    // Names, read at startup with GetSecretValue (never the values themselves).
    const secretSettings: Record<string, string> = {
      DISCORD_BOT_TOKEN_SECRET: DISCORD_TOKEN_SECRET_NAME,
      ...(anthropicKey ? { ANTHROPIC_API_KEY_SECRET: ANTHROPIC_KEY_SECRET_NAME } : {}),
    };

    // Music helpers ---------------------------------------------------------------
    // Where a helper uploads a song's audio and the voice task reads it back. Nothing is kept: a
    // song is deleted a day after it was fetched.
    const relay = new s3.Bucket(this, 'MusicRelay', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(1), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      // Deleted with the stack. (That needs it to be empty, which it is a day after the last song.)
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // What helpers talk to. It can only do what a valid helper token allows, and holds no secrets.
    const helper = new NodejsFunction(this, 'Helper', {
      ...lambdaDefaults('nimbus-helper'),
      description: 'What music helpers talk to: check in, take a request for a song, report on it',
      entry: join(props.projectRoot, 'src/aws/lambda/helper.ts'),
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        GUILD_ID: props.discord.guildId,
        DYNAMODB_TABLE: table.tableName,
        MUSIC_RELAY_BUCKET: relay.bucketName,
      },
    });
    // Only the helper registrations and song requests of this server: nothing else in the table.
    helper.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
        resources: [table.tableArn],
        conditions: {
          'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [`HELPER#${props.discord.guildId}`, `MUSICJOB#${props.discord.guildId}`] },
        },
      }),
    );
    // The upload forms it hands out are signed with this permission, and it needs no other in the bucket.
    helper.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [relay.arnForObjects('music/*')] }));
    const helperEndpoint = helper.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    // For every process that reads the bot's settings, so they all agree. BOT_SETTINGS may say
    // MUSIC_SOURCE=direct: the bot then fetches music itself, which YouTube refuses from AWS addresses.
    const musicSettings = {
      MUSIC_SOURCE: props.botSettings?.MUSIC_SOURCE ?? 'helpers',
      MUSIC_RELAY_BUCKET: relay.bucketName,
      MUSIC_HELPER_API_URL: helperEndpoint.url,
    };

    new scheduler.CfnScheduleGroup(this, 'ReminderSchedules', { name: SCHEDULE_GROUP });
    // Built from the name, not a reference: the function's own settings and permissions need its
    // ARN (it re-arms itself), and a reference to itself would be a circular dependency.
    const remindersArn = this.formatArn({ service: 'lambda', resource: 'function', resourceName: 'nimbus-reminders', arnFormat: ArnFormat.COLON_RESOURCE_NAME });
    const reminders = new NodejsFunction(this, 'Reminders', {
      ...lambdaDefaults('nimbus-reminders'),
      description: 'Delivers a reminder at its exact due time',
      entry: join(props.projectRoot, 'src/aws/lambda/reminders.ts'),
      memorySize: 512,
      // Waits up to 13 minutes for the due time.
      timeout: Duration.minutes(15),
      environment: { NODE_OPTIONS: '--enable-source-maps', ...botEnvironment, ...secretSettings, ...musicSettings },
    });
    const schedulerRole = new iam.Role(this, 'ReminderSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Lets EventBridge Scheduler wake the Nimbus reminders Lambda',
    });
    const invokeReminders = new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [remindersArn] });
    schedulerRole.addToPrincipalPolicy(invokeReminders);
    const reminderSettings = {
      REMINDER_FUNCTION_ARN: remindersArn,
      REMINDER_SCHEDULE_GROUP: SCHEDULE_GROUP,
      REMINDER_SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
    };
    for (const [key, value] of Object.entries(reminderSettings)) reminders.addEnvironment(key, value);

    /** Who may create, move and delete reminder wake-ups (and wake the Lambda directly). */
    const grantReminderAlarms = (grantee: iam.IGrantable) => {
      grantee.grantPrincipal.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['scheduler:CreateSchedule', 'scheduler:UpdateSchedule', 'scheduler:DeleteSchedule'],
          resources: [this.formatArn({ service: 'scheduler', resource: 'schedule', resourceName: `${SCHEDULE_GROUP}/*` })],
        }),
      );
      grantee.grantPrincipal.addToPrincipalPolicy(
        new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [schedulerRole.roleArn] }),
      );
      grantee.grantPrincipal.addToPrincipalPolicy(invokeReminders);
    };
    grantReminderAlarms(reminders);

    // The voice task -----------------------------------------------------------------
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, clusterName: 'nimbus' });
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'VoiceTask', {
      family: 'nimbus-voice',
      cpu: 512,
      memoryLimitMiB: 2048,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    taskDefinition.addContainer('nimbus', {
      image: ecs.ContainerImage.fromAsset(props.projectRoot, { file: 'Dockerfile', platform: Platform.LINUX_ARM64 }),
      environment: { ...botEnvironment, ...reminderSettings, ...musicSettings, AWS_REGION: this.region },
      secrets: {
        DISCORD_BOT_TOKEN: ecs.Secret.fromSecretsManager(discordToken),
        ...(anthropicKey ? { ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(anthropicKey) } : {}),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'voice',
        logGroup: new logs.LogGroup(this, 'VoiceTaskLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      }),
      stopTimeout: Duration.seconds(60),
    });
    const taskRole = taskDefinition.taskRole;
    for (const statement of [...speech, ...claude]) taskRole.addToPrincipalPolicy(statement);
    table.grantReadWriteData(taskRole);
    memories.grantReadWriteData(taskRole);
    queue.grantConsumeMessages(taskRole);
    queue.grantSendMessages(taskRole);
    grantReminderAlarms(taskRole);
    relay.grantRead(taskRole, 'music/*');

    // Commands -------------------------------------------------------------------------
    const worker = new NodejsFunction(this, 'Worker', {
      ...lambdaDefaults('nimbus-worker'),
      description: 'Runs slash commands and button clicks; starts the voice task for calls',
      entry: join(props.projectRoot, 'src/aws/lambda/worker.ts'),
      memorySize: 1024,
      // Interaction tokens last 15 minutes, so a reply can't usefully take longer.
      timeout: Duration.minutes(15),
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        ...botEnvironment,
        ...secretSettings,
        ...reminderSettings,
        ...musicSettings,
        VOICE_TASK_CLUSTER: cluster.clusterArn,
        VOICE_TASK_DEFINITION: taskDefinition.taskDefinitionArn,
        VOICE_TASK_SUBNETS: vpc.publicSubnets.map((subnet) => subnet.subnetId).join(','),
        VOICE_TASK_SECURITY_GROUPS: taskSecurityGroup.securityGroupId,
      },
    });
    for (const statement of claude) worker.addToRolePolicy(statement);
    // Any revision of the task definition, so a deploy never leaves the worker pointing at a stale one.
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [this.formatArn({ service: 'ecs', resource: 'task-definition', resourceName: 'nimbus-voice:*' })],
      }),
    );
    taskDefinition.taskRole.grantPassRole(worker.grantPrincipal);
    taskDefinition.obtainExecutionRole().grantPassRole(worker.grantPrincipal);
    grantReminderAlarms(worker);

    const edge = new NodejsFunction(this, 'Edge', {
      ...lambdaDefaults('nimbus-edge'),
      description: "Discord's Interactions Endpoint: checks signatures, says thinking, hands on to the worker",
      entry: join(props.projectRoot, 'src/aws/lambda/edge.ts'),
      memorySize: 256,
      timeout: Duration.seconds(5),
      environment: { NODE_OPTIONS: '--enable-source-maps', DISCORD_PUBLIC_KEY: props.discord.publicKey, WORKER_FUNCTION_NAME: worker.functionName },
    });
    worker.grantInvoke(edge);
    const endpoint = edge.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    for (const fn of [worker, reminders]) {
      table.grantReadWriteData(fn);
      memories.grantReadWriteData(fn);
      queue.grantSendMessages(fn);
      discordToken.grantRead(fn);
      anthropicKey?.grantRead(fn);
    }

    // Alerts -----------------------------------------------------------------------------
    if (props.alertEmail) {
      const topic = new sns.Topic(this, 'Alerts', { displayName: 'Nimbus alerts' });
      topic.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));
      for (const [name, fn] of Object.entries({ Edge: edge, Worker: worker, Reminders: reminders, Helper: helper })) {
        new cloudwatch.Alarm(this, `${name}Errors`, {
          alarmDescription: `Nimbus ${name.toLowerCase()} Lambda is failing`,
          metric: fn.metricErrors({ period: Duration.minutes(5) }),
          threshold: 1,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }).addAlarmAction(new actions.SnsAction(topic));
      }
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: 'nimbus-monthly',
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: props.monthlyBudgetUsd ?? 25, unit: 'USD' },
        },
        notificationsWithSubscribers: [
          {
            notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' },
            subscribers: [{ subscriptionType: 'EMAIL', address: props.alertEmail }],
          },
          {
            notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
            subscribers: [{ subscriptionType: 'EMAIL', address: props.alertEmail }],
          },
        ],
      });
    }

    new CfnOutput(this, 'InteractionsEndpointUrl', {
      value: endpoint.url,
      description: "Discord's Interactions Endpoint URL (set it with npm run aws:on)",
    });
    new CfnOutput(this, 'DataTable', { value: table.tableName });
    new CfnOutput(this, 'MemoryTable', { value: memories.tableName });
    new CfnOutput(this, 'VoiceQueueUrl', { value: queue.queueUrl });
    new CfnOutput(this, 'MusicHelperApiUrl', { value: helperEndpoint.url, description: 'What music helpers talk to (it is inside the code /musichelper gives out)' });
  }
}
