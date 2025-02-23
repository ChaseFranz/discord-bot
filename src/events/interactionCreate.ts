import { Interaction, Client } from 'discord.js';
import { InteractionHandler } from '../core/InteractionHandler.js';

class InteractionCreateEvent {
  name: string;

  constructor() {
    this.name = 'interactionCreate';
  }

  async execute(interaction: Interaction, client: Client): Promise<void> {
    const handler = new InteractionHandler(client);
    await handler.handle(interaction, client);
  }
}

export default new InteractionCreateEvent();
