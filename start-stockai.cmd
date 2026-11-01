@echo off
rem Opens the stockai UI, starting the background server first if needed.
powershell -NoProfile -WindowStyle Hidden -Command "$u='http://127.0.0.1:4317/'; $up={ try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $u | Out-Null; $true } catch { $false } }; if (-not (& $up)) { Start-Process wscript.exe ('\"' + $env:USERPROFILE + '\stock\start-stockai-hidden.vbs\"'); for ($i=0; $i -lt 60; $i++) { if (& $up) { break }; Start-Sleep -Seconds 1 } }; Start-Process $u"
