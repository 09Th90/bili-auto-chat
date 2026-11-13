@echo off
chcp 65001 >nul
set "VBS=%~dp0start-bridge-hidden.vbs"
set "ROOT=%~dp0.."
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $p=[IO.Path]::Combine($env:APPDATA,'Microsoft\Windows\Start Menu\Programs\Startup','B站自动聊天桥接.lnk'); $s=$w.CreateShortcut($p); $s.TargetPath='%VBS%'; $s.WorkingDirectory='%ROOT%'; $s.Save(); Write-Output ('已设置开机自启: ' + $p)"
echo 取消：删除上面的快捷方式即可。
pause
