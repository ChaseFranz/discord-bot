# Nimbus music helper

Nimbus can play music from YouTube in a voice call, but YouTube won't send audio to the servers Nimbus runs on. So the music is fetched by a small program that someone in the Discord server runs on their own computer: the music helper.

While at least one person has it running, `/play` and "Nimbus, play…" work for everyone in the server. When nobody does, Nimbus says so and points here.

## Set it up

You need to do this once. It takes about two minutes.

1. **Install Node.js 22 or newer** from <https://nodejs.org> (the "LTS" download). If you already have it, `node --version` in a terminal shows which.
2. **Download the helper.** It's one file, [`nimbus-music-helper.mjs`](https://raw.githubusercontent.com/ChaseFranz/discord-bot/main/helper/nimbus-music-helper.mjs). Save it anywhere, or fetch it from a terminal:

   ```powershell
   # Windows (PowerShell)
   irm https://raw.githubusercontent.com/ChaseFranz/discord-bot/main/helper/nimbus-music-helper.mjs -OutFile nimbus-music-helper.mjs
   ```

   ```bash
   # macOS or Linux
   curl -fsSLO https://raw.githubusercontent.com/ChaseFranz/discord-bot/main/helper/nimbus-music-helper.mjs
   ```

3. **Get your code.** In the Discord server, run `/musichelper`. Only you can see the reply. It contains a line like `node nimbus-music-helper.mjs nimbus1.eyJ…`.
4. **Run that line** in a terminal, in the folder where you saved the file.

The first time, it downloads two programs: [yt-dlp](https://github.com/yt-dlp/yt-dlp) (about 40 MB), which does the actual fetching from YouTube, and [ffmpeg](https://ffmpeg.org) (about 30 MB), which yt-dlp needs for live streams. If you already have ffmpeg installed, it uses yours and skips that download. Then it prints:

```text
Connected to Nimbus. Waiting for someone to ask for a song...
```

That's it. Ask Nimbus for a song.

## Using it

- **Start it** with `node nimbus-music-helper.mjs`. It remembers your code, so you don't need to paste it again.
- **Leave the window open** while you want music. It uses almost nothing while it waits.
- **Stop it** with Ctrl+C, or by closing the window. Music stops working unless someone else's helper is running.
- `/musichelper` in Discord shows whose helper is running right now.

If more than one person runs a helper, whichever asks first fetches each song. You don't have to be in the call yourself.

**Live streams** (a 24/7 radio stream, say) work too. An ordinary song is fetched in a few seconds and then your helper is done with it. A live stream is different: it is sent for as long as Nimbus is playing it, about 1 MB a minute, and stops when it's skipped, when the music is stopped, or when Nimbus leaves the call.

**Updating.** When there's a newer helper, download the file again over the old one (step 2 above) and start it as usual. Your code and the programs it downloaded are kept.

## What it does on your computer

It's reasonable to want to know this before running something a Discord bot told you to run. The whole program is the one file you downloaded, a few hundred lines you can read.

- **It only makes outgoing connections**, to three places: Nimbus (the address inside your code), YouTube (through yt-dlp), and GitHub (to download yt-dlp and ffmpeg, and to update yt-dlp). Nothing can connect in to your computer, and you don't need to change any router or firewall settings.
- **It doesn't read your files, your microphone, your Discord account or anything else.** It has no access to Discord at all.
- **It only fetches YouTube audio.** A request from Nimbus is either a YouTube video or words to search YouTube for. The helper checks that itself and refuses anything else.
- **YouTube sees the requests coming from your internet connection**, the same as if you had opened the video in a browser that isn't signed in. No Google account is involved. Bear in mind these are songs that *anyone in the server* asked for, not only you.
- **The audio isn't kept on your computer.** It passes through as it downloads. On Nimbus's side it is deleted after a day.
- **What it stores**, in a folder called `.nimbus-music-helper` in your home folder: your code, yt-dlp, and ffmpeg if it downloaded one.
- **Where the two programs come from.** yt-dlp is the official release from its own project, checked against the checksum published with it. ffmpeg is one fixed build (6.1.1) from the files the [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) project publishes, checked against a checksum written into the helper itself, so it can't be swapped for something else. To use an ffmpeg of your own instead, install it so that `ffmpeg` works in a terminal, or set `NIMBUS_FFMPEG` to where it is.

Fetching a song uses about as much data as streaming it yourself: roughly 1 MB a minute, down and up.

## Your code

The code from `/musichelper` is yours alone. Whoever has it can play audio through Nimbus as you, so don't share it or post it.

- **Lost it, or think someone else has it?** `/musichelper action:New code` gives you a new one, and the old one stops working at once.
- **Done with it?** `/musichelper action:Remove my helper` switches yours off. Then `node nimbus-music-helper.mjs --forget` removes the saved code from your computer. To remove everything, delete the `.nimbus-music-helper` folder and the file you downloaded.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `This needs Node.js 22 or newer` | Install the current LTS from <https://nodejs.org>, then open a new terminal. |
| `'node' is not recognized` or `command not found` | Node.js isn't installed, or the terminal was open before you installed it. Open a new one. |
| `That doesn't look like a helper code` | Copy the whole line from `/musichelper`, starting at `nimbus1.` and with nothing cut off. |
| `This helper code no longer works` | It was replaced or removed with `/musichelper`. Run `/musichelper action:New code` and start the helper with the new code. |
| `Lost touch with Nimbus` | Your internet connection dropped, or Nimbus is being updated. It keeps trying by itself. |
| `Could not fetch that: …` for one song | That video may be unavailable, private or blocked where you live. Try another. |
| `Could not fetch that: …` for every song | YouTube has probably changed something. The helper updates yt-dlp by itself when songs fail; give it a minute and try again. If it keeps failing, stop the helper, delete the `.nimbus-music-helper` folder (keep your code handy, or get a new one) and start again. |
| Nimbus still says nobody is running a helper | Check the window says `Connected to Nimbus`. It can take a few seconds after starting. |
| `Could not get ffmpeg: …` | Only live streams are affected; every other song still plays. It tries again the next time you start the helper. Or install ffmpeg yourself (see above). |
| Nimbus says a live stream needs a newer helper, or that yours has no ffmpeg | Download the helper again (see Updating), or see the row above. |

## How it works

For the curious:

1. Every couple of seconds the helper asks Nimbus, over HTTPS, "is there a song to fetch?". That question is also how Nimbus knows a helper is running.
2. When someone asks for a song, Nimbus answers the next helper that asks with the request and a one-time upload form.
3. The helper runs yt-dlp, which finds the video and downloads its audio. The helper tells Nimbus which video it is, and uploads the audio in pieces as it arrives.
4. Nimbus starts playing as soon as the first piece is there, and plays the rest as it comes in.
5. A song is uploaded as fast as your connection allows, so a few seconds in, the whole of it is with Nimbus and your computer is no longer needed for it. A live stream has no end, so its pieces go up every few seconds for as long as Nimbus keeps saying it is listening. If Nimbus stops saying so (the song was skipped, or the call ended), the helper is told to stop at its next piece.

The service side of this is in [`src/music/relay/`](../src/music/relay/).
