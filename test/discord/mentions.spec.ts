import { resolveMentions } from '../../src/discord/mentions.js';

const lookup = {
  botId: '111',
  assistantName: 'Nimbus',
  userName: (id: string) => ({ '222': 'Sam', '333': 'Zoe  Q' })[id],
  roleName: (id: string) => ({ '444': 'Raiders' })[id],
  channelName: (id: string) => ({ '555': 'general' })[id],
};

describe('resolveMentions', () => {
  it('drops the mention that addresses the bot and names the rest', () => {
    expect(resolveMentions('<@111> remind <@222> and <@!333> about the raid', lookup)).toBe(
      'remind @Sam (user 222) and @Zoe Q (user 333) about the raid',
    );
    expect(resolveMentions('what do you think <@111>?', lookup)).toBe('what do you think');
    expect(resolveMentions('ask <@111> later, okay <@111>', lookup)).toBe('ask Nimbus later, okay');
  });

  it('turns roles, channels, emoji and timestamps into text', () => {
    expect(resolveMentions('<@111> ping <@&444> in <#555> <:pog:999> at <t:1795633200:f>', lookup)).toBe(
      'ping @Raiders in #general :pog: at 2026-11-25T19:00:00Z',
    );
    expect(resolveMentions('<@111> who is <@777>?', lookup)).toBe('who is @user 777?');
  });
});
