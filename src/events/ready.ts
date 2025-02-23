import { ActivityType, Client } from 'discord.js';

class ReadyEvent {
  name = 'ready';
  once = true;

  execute(client: Client): void {
    client.user?.setActivity('chatting with humans', { type: ActivityType.Playing });
    client.logger.info('Bot is online!');
  }
}

export default new ReadyEvent();
