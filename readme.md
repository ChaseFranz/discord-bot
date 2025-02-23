# Discord ChatGPT Bot

A feature-rich Discord bot that integrates ChatGPT for conversational interactions, creative responses, and more. Built using Node.js, discord.js, and OpenAI's GPT-3.5-turbo model, this bot offers modular commands, context menu commands, customization options, and a foundation for future enhancements (such as voice interaction and multi-language support).

## Features

- **Text Interaction:**  
  Chat with ChatGPT using slash commands (`/chat`) with conversation history and custom parameters.

- **Customization:**  
  Adjust response parameters with the `/customize` command to change the temperature and conversational style.

- **Context Menu Commands:**  
  - **Describe This User:** Right-click on a user to get a creative profile description.  
  - **Summarize This Message:** Right-click on a message to receive a concise summary.

- **Multi-Language Support:**  
  Use `/setlanguage` to set your preferred language for system instructions.

- **Enhanced Help:**  
  A dynamic `/help` command displays detailed usage examples for all commands.

- **Modular Structure:**  
  Commands and event handlers are split into separate modules for maintainability and scalability.

## Project Structure
- todo

## Installation
1. **Clone the repository**
```bash
   git clone https://github.com/yourusername/discord-bot.git
   cd discord-bot
```

2. Install Dependencies
Ensure you have [Node.js](https://nodejs.org/en) installed, then run:
```bash
    npm install
```

3. Configure the bot
Create a `config.js` file in the root directory with your credentials. For example:
```js
export default {
  openaiApiKey: "YOUR_OPENAI_API_KEY_HERE",
  discordBotToken: "YOUR_DISCORD_BOT_TOKEN_HERE",
  clientId: "YOUR_DISCORD_APPLICATION_ID_HERE",
  guildId: "YOUR_TEST_GUILD_ID_HERE"
};
```

4. Run the bot
```bash
    node index.js
```

## Usage
- **Chat with ChatGPT:**
Use the `/chat` command followed by your prompt.
Example:
/chat Tell me a funny joke about cats.

- **Customize Responses:**
Use the `/customize` command to adjust the response temperature and style. Example: `/customize temperature: 0.8 style: casual`

- **Set Language:**
Use `/setlanguage` to choose a language for system instructions.
Example:
`/setlanguage language: es`

- **Reset Conversation:**
Use `/reset` to clear your conversation context.

- **Context Menu Commands:**
    
    - Right-click on a user and select "Describe This User" to get a creative description.
    
    - Right-click on a message and select "Summarize This Message" to get a one-sentence summary.
    
- Get Help: Use `/help` to see a dynamic list of all available commands with usage examples.

## Development
- **Modular Structure:**
Commands and events are loaded dynamically from the `commands/` and `events/` folders, respectively.

- **Logging:**
The project uses [Winston](https://www.npmjs.com/package/winston) for structured logging.

- **Customization**: User settings (like temperature, style, and language) are stored in-memory for each user and channel combination. Consider adding persistent storage if you plan to scale further.

## Future Enhancements
- **Voice Interaction:**
Integrate @discordjs/voice for voice commands, speech-to-text transcription, and text-to-speech responses.

- **Persistent Storage:**
Use a database or file system for saving conversation histories and user settings across sessions.

- **Advanced Analytics & Monitoring:**
Integrate usage analytics and logging services such as CloudWatch.

## Contributing
Contributions are welcome! Please open an issue or submit a pull request for any improvements or new features.

## License
[MIT License]()
