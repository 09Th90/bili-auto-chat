@echo off
rem One-click launcher for bili-auto-chat extension on Edge.
rem --load-extension only works on a fresh Edge start; if Edge is already
rem running, fall back to opening edge://extensions for a one-time manual load.
rem NOTE: this file must stay GBK-encoded (see README), do not save as UTF-8.
rem Uses findstr (Windows-only) so Git Bash PATH cannot shadow it.
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set "EXT=G:\Agent Work\ÈÕ³£±à³Ì\bili-auto-chat"

tasklist /fi "imagename eq msedge.exe" 2>nul | findstr /i /c:"msedge.exe" >nul
if %errorlevel%==0 (
  start "" "%EDGE%" "edge://extensions"
  powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('Edge is already running, so the load flag cannot apply to it now.  The extensions page has been opened instead.' + [char]10 + [char]10 + 'To install (only needed once):' + [char]10 + '1. Toggle ON Developer mode' + [char]10 + '2. Click Load unpacked' + [char]10 + '3. Select the bili-auto-chat folder (a shortcut to it is on your Desktop)' + [char]10 + [char]10 + 'Once loaded it stays enabled permanently.', 'Bili Auto Chat')"
) else (
  start "" "%EDGE%" --load-extension="%EXT%"
)
