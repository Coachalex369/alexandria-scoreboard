# Manual release test: Windows install (x64 PC and ARM64 second user)

Run once on a separate x64 PC and once on an ARM64 machine under a second, fresh Windows user account. Use the files
from the GitHub Actions run (artifact `alexandria-scoreboard-windows`) or the draft release. Write PASS / FAIL and a
note per step; attach a screenshot for steps 6 and 9.

| # | Step | Expected |
|---|---|---|
| 1 | Download `Alexandria-Scoreboard-Setup-<version>-x64.exe` (or `-arm64.exe`) in Edge or Chrome | The browser may say the file "isn't commonly downloaded": choose **Keep** (Edge: **…** → **Keep** → **Show more** → **Keep anyway**) |
| 2 | Run the installer | SmartScreen shows **"Windows protected your PC"**: click **More info**, then **Run anyway**. If Smart App Control is ON (Settings → Privacy & security → Windows Security → App & browser control → Smart App Control), Windows may block it with no override: record that and stop |
| 3 | Installer wizard | No administrator prompt (per-user install). Default folder is under `%LOCALAPPDATA%\Programs`. Finish with "Run Alexandria Scoreboard" ticked |
| 4 | Shortcuts | **Alexandria Scoreboard** in the Start menu and on the desktop |
| 5 | First start | The board opens in a window without a console window. With no Claude Code activity it reads **NO SESSION**; the GAME CLOCK shows `--:--` |
| 6 | Demo mode | **Scoreboard → Demo A** and **Demo B** replay: GAME CLOCK counts down, ticker scrolls, YOUR MOVE counts up only while the demo waits on the user, no digit blinks |
| 7 | Connect to Claude Code (needs Node.js LTS from nodejs.org) | In PowerShell: `node "$env:LOCALAPPDATA\Programs\Alexandria Scoreboard\resources\app\tools\install-collector-v3.mjs"` (dry run, lists changes), then the same with `--apply`. Note the rollback stamp it prints |
| 8 | Live session | Start a new Claude Code session and ask for a small change. The board picks the session, TURN goes to 1, STEPS DONE rises when work completes, the ticker describes the task |
| 9 | YOUR MOVE | Trigger a permission prompt in Claude Code (a command not yet allowed). While the dialog is open: GAME CLOCK reads **CLOCK STOPPED · APPROVAL**, YOUR MOVE counts up with **APPROVAL NEEDED**. After you answer it goes dark |
| 10 | Window menu | **View → Always on top** and **Compact** work; **Help → About** shows the version |
| 11 | Uninstall | Settings → Apps → Installed apps → **Alexandria Scoreboard** → Uninstall. The app folder and both shortcuts are removed |
| 12 | Remove the collector | `node "$env:LOCALAPPDATA\Programs\Alexandria Scoreboard\resources\app\tools\install-collector-v3.mjs" --rollback <stamp>` with the stamp from step 7 (the printed command uses a relative path; use this full one). If the app is already uninstalled, run the same file from the extracted ZIP. Claude Code keeps working without the hooks |

ARM64 only: in Task Manager → Details, add the **Architecture** column; `Alexandria Scoreboard.exe` should show **ARM64**.
