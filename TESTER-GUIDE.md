# Anand Studio — Tester Guide

Thank you for testing! This studio turns a song idea into a finished YouTube video using AI agents.
It runs on your own Windows PC and uses **your own** free accounts and keys. Nothing of yours is sent to me.

## 1. Install two free programs (once)

Open **PowerShell** and run:

```
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
```

Close PowerShell and open it again after installing.

## 2. Unzip the studio

- Unzip this folder somewhere simple, like `C:\anand-studio`
- Do **not** put it inside OneDrive or Google Drive

## 3. Start it

- Double-click **Start Studio.bat**
- Your browser opens at **http://localhost:4600**
- Keep the black window open while you use it. Closing it stops the studio.
- If Windows blocks the file: right-click it → **Properties** → tick **Unblock** → OK.

## 4. Add your own free keys

In the studio, open **Settings** and paste:

| Key | Where to get it (free) | What it does |
|---|---|---|
| AI Studio key | aistudio.google.com → Get API key | Writes songs, scripts, prompts |
| Hugging Face token | huggingface.co → Settings → Access Tokens → "Read" | Free images |
| YouTube Data API key | Google Cloud Console → YouTube Data API v3 | Topic research |

You can start with just the **AI Studio key**. Add the others later.

## 5. Sign into your own sites (optional, once)

For music and some video clips, the agents use websites like Suno, Google Flow and Meta Vibes in the studio's own browser.
Sign into **your own** accounts there once. The agents reuse that login next time.
The agents never type passwords, never buy credits and never create accounts.

These browser jobs also need **Claude Code** installed and signed in on your PC. Without it, the writing, image and clip steps still work.

## 6. Make your first video

1. Open a channel from the Home page
2. Click **Research** and pick one of the 4 ideas
3. Approve the song or script
4. Let the agents make images and clips, then the edit
5. Watch `final.mp4` and download the upload package

## What to tell me

Please send me:
- Did it start? (yes / no, and any error text)
- Which step stopped or felt confusing?
- How long did one video take?

Contact: anandhk117@gmail.com
