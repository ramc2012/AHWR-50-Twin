@echo off
setlocal
title Create Complete AHWR-50-Twin Transfer
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0export_offline.ps1"
if errorlevel 1 (
    echo.
    echo TRANSFER ARCHIVE CREATION FAILED.
    pause
    exit /b 1
)

echo.
echo Complete transfer archive is ready.
pause
