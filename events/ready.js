export default {
    name: 'ready',
    once: true,
    execute(client) {
      client.user.setActivity('chatting with humans', { type: 'PLAYING' });
      client.logger.info('Bot is online!');
    },
  };
  