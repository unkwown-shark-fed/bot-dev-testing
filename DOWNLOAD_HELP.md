# Download Help

If GitHub is not letting you download the repository, use one of these options.

## Option 1: Download from GitHub as a ZIP

1. Open the repository page in your browser.
2. Click the green **Code** button.
3. Click **Download ZIP**.
4. Right-click the downloaded file and choose **Extract All**.
5. Open the extracted folder and follow `DESKTOP_INSTALL.md`.

If the **Download ZIP** button is missing or disabled, you probably do not have access to the repository.
Ask the repository owner to invite your GitHub account or to send you a release ZIP.

## Option 2: Clone with Git

1. Install Git from <https://git-scm.com/downloads>.
2. Open PowerShell in the folder where you want the bot.
3. Run:

```powershell
git clone REPOSITORY_URL
cd bot-dev-testing
```

Replace `REPOSITORY_URL` with the repository HTTPS clone URL from GitHub.

## Option 3: Download the desktop package from GitHub Actions

This repo includes a workflow named **Build desktop GUI download**. The repository owner can run it and send you
the generated artifact.

Repository owner steps:

1. Open the GitHub repository.
2. Click **Actions**.
3. Click **Build desktop GUI download**.
4. Click **Run workflow**.
5. When the run finishes, download the **discord-utility-bot-desktop-gui** artifact.
6. Send that ZIP file to the PC that will run the bot.

User steps after receiving the ZIP:

1. Right-click the ZIP and choose **Extract All**.
2. Open the extracted folder.
3. Double-click `install-windows.bat`.
4. Use the **Discord Utility Bot GUI** Desktop shortcut.

## Still blocked?

If you still cannot download anything, it is usually one of these issues:

- The repository is private and your GitHub account was not invited.
- Your browser or antivirus blocked ZIP downloads.
- Your network blocks GitHub downloads.
- You are trying to download from a pull request page instead of the main repository page.

In that case, ask the repository owner to run the GitHub Actions workflow and send you the artifact ZIP directly.
