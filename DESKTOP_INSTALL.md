# Desktop GUI Installation

This project includes a PC desktop launcher for the Discord bot. It is designed for Windows users who want
to run the bot from a GUI instead of typing commands every time.

## What you install first

1. Install **Node.js LTS** from <https://nodejs.org/>.
2. Download or copy this bot project folder to your PC.
3. Keep the whole folder together. The GUI runs the bot from this folder.

## One-click Windows setup

1. Double-click `install-windows.bat`.
2. Wait while it runs `npm install` and downloads dependencies.
3. When it finishes, use the new **Discord Utility Bot GUI** shortcut on your Desktop.

If Windows SmartScreen warns you, choose **More info** and **Run anyway** only if this project folder came
from a source you trust.

## Manual setup

If you prefer the terminal:

```bat
npm install
npm run gui
```

## What the GUI does

After the desktop window opens, fill in these values and click **Save settings**:

- Discord bot token
- Discord application client ID
- Discord guild/server IDs
- MongoDB URI, if you use dashboard commands or database features
- Dashboard password and dashboard port

Then use the buttons in order:

1. **Install dependencies** if this has not already been done.
2. **Deploy slash commands** after credentials are saved.
3. **Start bot** to bring the Discord bot online.
4. Optional: **Start dashboard** and **Open dashboard** for the web dashboard.

## Starting it later

Use either option:

- Double-click the **Discord Utility Bot GUI** Desktop shortcut created by `install-windows.bat`.
- Double-click `run-bot-gui.bat` inside this project folder.
- Run `npm run gui` from this project folder.

## Important notes

- Do not move only the shortcut. If you move the project folder, run `install-windows.bat` again so the
  shortcut points to the new location.
- The `.env` file created by the GUI stores secrets like your Discord token. Do not share it.
- This is a launcher-style install, not a signed MSI/EXE installer. Building a signed installer requires
  code-signing certificates and a packaging pipeline.
