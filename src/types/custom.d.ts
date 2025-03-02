import { Client, Collection } from 'discord.js';
import OpenAI from 'openai';

/**
 * Extends the `Client` interface from the `discord.js` module.
 */
declare module 'discord.js' {
  export interface Client {
    /**
     * A collection of commands where the key is a string and the value can be of any type.
     */
    commands: Collection<string, any>;

    /**
     * A map that stores conversation histories. The key is a string (e.g., user ID) and the value is an array of any type.
     */
    conversationHistories: Map<string, any[]>;

    /**
     * A map that stores cooldowns for commands. The key is a string (e.g., command name) and the value is another map where the key is a string (e.g., user ID) and the value is a number representing the cooldown timestamp.
     */
    cooldowns: Map<string, Map<string, number>>;

    /**
     * A map that stores user settings. The key is a string (e.g., user ID) and the value can be of any type.
     */
    userSettings: Map<string, any>;

    /**
     * An instance of the OpenAI API client or any other related object.
     */
    openai: OpenAI;

    /**
     * A logger instance for logging purposes.
     */
    logger: any;

    openaiChatModel: string;
  }
}
