@echo off
setlocal
title Restore Complete AHWR-50-Twin Transfer
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0import_offline.ps1"
if errorlevel 1 (
    echo.
    echo RESTORE FAILED.
    pause
    exit /b 1
)

echo.
echo Restore completed.
pause
