import { ContextMenuCommandBuilder, SlashCommandBuilder, SlashCommandOptionsOnlyBuilder } from "discord.js";

export interface IBotCommand {
    data?: SlashCommandOptionsOnlyBuilder | ContextMenuCommandBuilder | SlashCommandBuilder;
    usage?: string;
  }