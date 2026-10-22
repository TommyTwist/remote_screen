@echo off
rem Screen Hub TV Remote: double-click to start the tool and open its control page.
rem Opening it again while it is running just shows the page. Keep this file next to tvremote.py.
setlocal
cd /d "%~dp0"
set "PYW="
where pyw >nul 2>&1 && set "PYW=pyw -3"
if not defined PYW where pythonw >nul 2>&1 && set "PYW=pythonw"
if not defined PYW (
  echo TV Remote needs Python 3. Opening the download page...
  echo Install it, tick "Add python.exe to PATH", then double-click TV Remote again.
  start "" "https://www.python.org/downloads/windows/"
  pause
  exit /b 1
)
rem First run: put a "TV Remote" shortcut on the desktop
powershell -NoProfile -ExecutionPolicy Bypass -Command "$l = Join-Path ([Environment]::GetFolderPath('Desktop')) 'TV Remote.lnk'; if (-not (Test-Path $l)) { $s = (New-Object -ComObject WScript.Shell).CreateShortcut($l); $s.TargetPath = '%~f0'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = '%~dp0tvremote.ico'; $s.WindowStyle = 7; $s.Description = 'Screen Hub TV Remote'; $s.Save() }" >nul 2>&1
start "" %PYW% "%~dp0tvremote.py" ui
exit /b 0
