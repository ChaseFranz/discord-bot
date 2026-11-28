# Nimbus music helper

Nimbus can play music from YouTube in a voice call, but YouTube won't send audio to the servers Nimbus runs on. So the music is fetched by a small program that someone in the Discord server runs on their own computer: the music helper.

While at least one person has it running, `/play` and "Nimbus, play…" work for everyone in the server. When nobody does, Nimbus says so and points here.

## Set it up

You need to do this once. It takes a few minutes.

1. **Get your line.** In the Discord server, run `/musichelper`. Only you can see the reply. It has a line for Windows and one for macOS and Linux, each with your personal code at the end.
2. **Run it.** Open a terminal (on Windows: PowerShell, Terminal or Command Prompt; on a Mac: Terminal), paste the line for your computer and press Enter.

It sets the helper up in a folder called `.nimbus-music-helper` in your user folder, and starts it. The first time, it downloads what the helper needs:

- [Node.js](https://nodejs.org), which the helper runs on (about 40 MB on Windows, 60 MB on a Mac or Linux), unless you already have version 22 or newer;
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (about 40 MB), which does the actual fetching from YouTube;
- [ffmpeg](https://ffmpeg.org) (about 30 MB), which yt-dlp needs for live streams, unless you already have it.

Then it prints:

```text
Connected to Nimbus. Waiting for someone to ask for a song...
```

That's it. Ask Nimbus for a song.

### Or set it up by hand

If you'd rather not run a script from the internet, or you already have Node.js:

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

3. **Get your code** with `/musichelper`: it's the part of either line that starts with `nimbus1.`
4. **Run** `node nimbus-music-helper.mjs <your code>` in a terminal, in the folder where you saved the file. It downloads yt-dlp and ffmpeg the same way.

## Using it

- **Start it** by running the same line from `/musichelper` again, without the code at the end. It remembers your code. If you no longer have the line, `/musichelper` shows it again (without the code). Set up by hand? Then `node nimbus-music-helper.mjs` starts it.
- **Leave the window open** while you want music. It uses almost nothing while it waits.
- **Stop it** with Ctrl+C, or by closing the window. Music stops working unless someone else's helper is running.
- `/musichelper` in Discord shows whose helper is running right now.

If more than one person runs a helper, whichever asks first fetches each song. You don't have to be in the call yourself.

**Live streams** (a 24/7 radio stream, say) work too. An ordinary song is fetched in a few seconds and then your helper is done with it. A live stream is different: it is sent for as long as Nimbus is playing it, about 1 MB a minute, and stops when it's skipped, when the music is stopped, or when Nimbus leaves the call.

**Updating.** Starting the helper with the line from `/musichelper` also brings it up to date. If you set it up by hand, download the file again over the old one (step 2 above) and start it as usual. Your code and the programs it downloaded are kept either way.

## What it does on your computer

It's reasonable to want to know this before running something a Discord bot told you to run. The whole program is one file, [`nimbus-music-helper.mjs`](nimbus-music-helper.mjs), a few hundred lines you can read.

- **The line from `/musichelper`** downloads and runs a short script: [`install.ps1`](install.ps1) on Windows, [`install.sh`](install.sh) on macOS and Linux, each under two hundred lines you can read first. It uses your Node.js if you have version 22 or newer, and otherwise downloads one fixed version from nodejs.org. Then it downloads the latest helper from GitHub and starts it. It needs no admin rights and changes nothing outside the `.nimbus-music-helper` folder: nothing is added to your PATH, and nothing is set to start by itself.
- **It only makes outgoing connections**: to Nimbus (the address inside your code), to YouTube (through yt-dlp), to GitHub (to download the helper, yt-dlp and ffmpeg, and to update yt-dlp), and to nodejs.org (once, and only if it downloads Node.js). Nothing can connect in to your computer, and you don't need to change any router or firewall settings.
- **It doesn't read your files, your microphone, your Discord account or anything else.** It has no access to Discord at all.
- **It only fetches YouTube audio.** A request from Nimbus is either a YouTube video or words to search YouTube for. The helper checks that itself and refuses anything else.
- **YouTube sees the requests coming from your internet connection**, the same as if you had opened the video in a browser that isn't signed in. No Google account is involved. Bear in mind these are songs that *anyone in the server* asked for, not only you.
- **The audio isn't kept on your computer.** It passes through as it downloads. On Nimbus's side it is deleted after a day.
- **What it stores**, all in the `.nimbus-music-helper` folder in your user folder: your code, yt-dlp, ffmpeg if it downloaded one, and, if you used the line from `/musichelper`, the helper itself and Node.js if it downloaded one.
- **Where the programs come from.** Node.js is one fixed version (26.13.1), the official build from nodejs.org, checked against a checksum written into the installer. yt-dlp is the official release from its own project, checked against the checksum published with it. ffmpeg is one fixed build (6.1.1) from the files the [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) project publishes, checked against a checksum written into the helper itself. None of them can be swapped for something else on the way. To use an ffmpeg of your own instead, install it so that `ffmpeg` works in a terminal, or set `NIMBUS_FFMPEG` to where it is.

Fetching a song uses about as much data as streaming it yourself: roughly 1 MB a minute, down and up.

## Your code

The code from `/musichelper` is yours alone. Whoever has it can play audio through Nimbus as you, so don't share it or post it.

- **Lost it, or think someone else has it?** `/musichelper action:New code` gives you a new one, and the old one stops working at once.
- **Done with it?** `/musichelper action:Remove my helper` switches yours off. Then delete `config.json` in the `.nimbus-music-helper` folder to remove the saved code from your computer (set up by hand, `node nimbus-music-helper.mjs --forget` does the same). To remove everything, delete the `.nimbus-music-helper` folder, and the file you downloaded if you set it up by hand.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `This is the line for macOS and Linux` | You ran it on Windows (in Git Bash, say). Use the Windows line from `/musichelper` instead. |
| `There's no ready-made Node.js here for …` | nodejs.org has no download for this kind of computer (32-bit Windows, say, or a Linux without glibc, such as Alpine). Install Node.js 22 or newer another way, from your system's packages for instance, and run the line again: it will use yours. |
| `The Node.js download did not match its known checksum` | The download was damaged or changed on its way, so it wasn't used. Try again. If it keeps happening, something between you and nodejs.org is changing downloads: don't use that network for this. |
| `Could not download Node.js from nodejs.org` or `Could not download the helper from GitHub` | Check your internet connection and try again. |
| `This needs Node.js 22 or newer` | You set it up by hand with an older Node.js. Install the current LTS from <https://nodejs.org> and open a new terminal, or use the line from `/musichelper`, which brings its own. |
| `'node' is not recognized` or `command not found` | Set up by hand: Node.js isn't installed, or the terminal was open before you installed it. Open a new one. |
| `That doesn't look like a helper code` | Copy the whole line from `/musichelper`, with nothing cut off at the end. |
| `This helper code no longer works` | It was replaced or removed with `/musichelper`. Run `/musichelper action:New code` and start the helper with the new line. |
| `Lost touch with Nimbus` | Your internet connection dropped, or Nimbus is being updated. It keeps trying by itself. |
| `Could not fetch that: …` for one song | That video may be unavailable, private or blocked where you live. Try another. |
| `Could not fetch that: …` for every song | YouTube has probably changed something. The helper updates yt-dlp by itself when songs fail; give it a minute and try again. If it keeps failing, stop the helper, delete the `.nimbus-music-helper` folder (keep your code handy, or get a new one) and start again. |
| Nimbus still says nobody is running a helper | Check the window says `Connected to Nimbus`. It can take a few seconds after starting. |
| `Could not get ffmpeg: …` | Only live streams are affected; every other song still plays. It tries again the next time you start the helper. Or install ffmpeg yourself (see above). |
| Nimbus says a live stream needs a newer helper, or that yours has no ffmpeg | Start the helper with the line from `/musichelper` (or, set up by hand, download it again: see Updating), or see the row above. |

## How it works

For the curious:

1. The helper asks Nimbus, over HTTPS, "is there a song to fetch?": every couple of seconds while Nimbus is in a call or on its way to one, and every 15 seconds the rest of the time (Nimbus tells it which). That question is also how Nimbus knows a helper is running.
2. When someone asks for a song, Nimbus answers the next helper that asks with the request and a one-time upload form.
3. The helper runs yt-dlp, which finds the video and downloads its audio. The helper tells Nimbus which video it is, and uploads the audio in pieces as it arrives.
4. Nimbus starts playing as soon as the first piece is there, and plays the rest as it comes in.
5. A song is uploaded as fast as your connection allows, so a few seconds in, the whole of it is with Nimbus and your computer is no longer needed for it. A live stream has no end, so its pieces go up every few seconds for as long as Nimbus keeps saying it is listening. If Nimbus stops saying so (the song was skipped, or the call ended), the helper is told to stop at its next piece.

The service side of this is in [`src/music/relay/`](../src/music/relay/).
