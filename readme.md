# Discord ChatGPT Bot
A feature-rich Discord bot that integrates ChatGPT for both conversational and creative interactions. Built with Node.js, discord.js, and OpenAI's GPT-3.5-turbo model, the bot now includes voice integration, dynamic language support, and enhanced customization options – all wrapped in a modular, scalable architecture.

## Features

- **Text Interaction:**  
  Chat with ChatGPT using slash commands (e.g., `/chat`) that maintain conversation history and support custom parameters.

- **Voice Interaction:**  
  Enable hands-free control with voice commands. The bot supports speech-to-text transcription and text-to-speech responses via integrated voice libraries.

- **Customization:**  
  Adjust response parameters like temperature and conversational style using the `/customize` command.

- **Multi-Language Support:**  
  Switch system language on the fly using `/setlanguage`.

- **Context Menu Commands:**  
  - **Describe This User:** Right-click on a user to receive a creative profile description.  
  - **Summarize This Message:** Right-click on a message to generate a one-sentence summary.

- **Enhanced Help:**  
  A dynamic `/help` command lists all commands and usage examples.

- **Modular Structure:**  
  Commands and event handlers are organized into separate modules for easy maintenance and scalability.

## Project Structure

- `commands/` – Contains all the slash and context menu commands.
- `events/` – Houses event listeners.
- `dist/` – Compiled JavaScript output.
- Other configuration and utility files.

## Installation

1. **Clone the Repository:**

    ```bash
    git clone https://github.com/yourusername/discord-bot.git
    cd discord-bot
    ```

2. **Install Dependencies:**

    Ensure you have [Node.js](https://nodejs.org/en) installed, then run:

    ```bash
    npm install
    ```

3. **Configure the Bot:**

    Create a [.env](http://_vscodecontentref_/0) file in the root directory with your credentials and configuration options. For example:

    ```.env
    OPENAI_API_KEY=YOUR_OPENAI_API_KEY_HERE
    DISCORD_BOT_TOKEN=YOUR_DISCORD_BOT_TOKEN_HERE
    CLIENT_ID=YOUR_DISCORD_APPLICATION_ID_HERE
    GUILD_ID=YOUR_TEST_GUILD_ID_HERE
    OPENAI_MODEL=gpt-3.5-turbo

    # AWS configuration (if using AWS services)
    AWS_ACCESS_KEY_ID=YOUR_ACCESS_KEY
    AWS_SECRET_ACCESS_KEY=YOUR_SECRET_KEY
    AWS_REGION=YOUR_AWS_REGION
    ```

    Make sure to load these configurations in your application (e.g., using the `dotenv` package):

    ```js
    // filepath: /c:/Users/Chase/discord-bot/index.js
    require('dotenv').config();
    // ...existing code...
    ```

4. **Configure TypeScript:**

    A [tsconfig.json](http://_vscodecontentref_/1) file is provided to compile both `.ts` and `.js` files. Adjust compiler options as required.

## Building and Running

1. **Build the Project:**

    Compile the TypeScript files into JavaScript by running:

    ```bash
    npm run build
    ```

    This outputs the compiled files into the [dist](http://_vscodecontentref_/2) directory.

2. **Run the Bot:**

    Start the bot with:

    ```bash
    npm run start
    ```

## Usage

- **Chat with ChatGPT:**  
  Invoke `/chat` followed by your prompt.  
  _Example:_  
  `/chat Tell me a funny joke about cats.`

- **Customize Responses:**  
  Use `/customize` to adjust response parameters.  
  _Example:_  
  `/customize temperature: 0.8 style: casual`

- **Voice Interaction:**  
  If enabled, use voice commands to interact with the bot. Refer to the help docs or `/help` for usage details.

- **Set Language:**  
  Switch system language via `/setlanguage`.  
  _Example:_  
  `/setlanguage language: es`

- **Reset Conversation:**  
  Clear conversation history by using `/reset`.

- **Context Menu Commands:**  
  - Right-click on a user and select "Describe This User" for a creative profile.  
  - Right-click on a message and select "Summarize This Message" for a concise summary.

- **Help:**  
  Use `/help` to display all available commands with usage examples.

## Development

- **Modular Loading:**  
  Commands and event handlers are dynamically loaded from the `commands/` and `events/` directories.

- **Logging:**  
  The project uses [Winston](https://www.npmjs.com/package/winston) for structured logging.

- **User Customization:**  
  In-memory storage is currently used for user settings (like temperature, style, and language). For larger deployments, consider integrating persistent storage.


## Future Enhancements

- **Analytics & Monitoring:**  
  Integrate advanced monitoring services such as AWS CloudWatch for usage analytics.

- **Persistent Storage:**  
  Implement a database layer to store conversation history and user settings across sessions.

- **Additional Customization:**  
  Further refine interactions with additional customization options and NLP enhancements.

## Contributing

Contributions are welcome! Please submit an issue or open a pull request for any improvements or new features.

## License

MIT License
