import 'dotenv/config';

/**
 * Config class to manage and validate environment variables.
 * This class uses the singleton pattern to ensure that the configuration
 * is only instantiated once and provides a single source of truth for
 * environment variables throughout the application.
 */
class Config {
  private static instance: Config;

  public readonly discordBotToken: string;
  public readonly clientId: string;
  public readonly guildId: string;
  public readonly openaiApiKey: string;
  public readonly openaiChatModel: string;
  public readonly openaiVoiceModel: string;
  
  /**
   * Private constructor to prevent direct instantiation.
   * Initializes the configuration by reading environment variables
   * and validates their presence.
   */
  private constructor() {
    this.discordBotToken = process.env.DISCORD_BOT_TOKEN || '';
    this.clientId = process.env.CLIENT_ID || '';
    this.guildId = process.env.GUILD_ID || '';
    this.openaiApiKey = process.env.OPENAI_API_KEY || '';
    this.openaiChatModel = process.env.OPENAI_CHAT_MODEL || 'gpt-3.5-turbo';
    this.openaiVoiceModel = process.env.OPENAI_VOICE_MODEL || 'gpt-4o-mini';
    this.validate();
  }

  /**
   * Returns the singleton instance of the Config class.
   * If the instance does not exist, it creates one.
   * @returns {Config} The singleton instance of the Config class.
   */
  public static getInstance(): Config {
    if (!Config.instance) {
      Config.instance = new Config();
    }
    return Config.instance;
  }

  /**
   * Validates the presence of required environment variables.
   * Throws an error if any required variable is missing.
   */
  private validate(): void {
    if (!this.discordBotToken) {
      throw new Error('DISCORD_BOT_TOKEN is not set in the environment variables.');
    }
    if (!this.clientId) {
      throw new Error('CLIENT_ID is not set in the environment variables.');
    }
    if (!this.guildId) {
      throw new Error('GUILD_ID is not set in the environment variables.');
    }
    if (!this.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is not set in the environment variables.');
    }
    if (!this.openaiChatModel) {
      throw new Error('OPENAI_CHAT_MODEL is not set in the environment variables.');
    }
    if (!this.openaiVoiceModel) {
      throw new Error('OPENAI_VOICE_MODEL is not set in the environment variables.');
    }
  }
}

export const config = Config.getInstance();
