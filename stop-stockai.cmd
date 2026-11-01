@echo off
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue; if ($c) { Stop-Process -Id $c.OwningProcess -Force; 'stockai stopped.' } else { 'stockai is not running.' }"
