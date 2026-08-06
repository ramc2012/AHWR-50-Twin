@echo off
setlocal
title Create AHWR-50-Twin Code Update package
cd /d "%~dp0"

echo ========================================================
echo  Building a CODE-ONLY update package.
echo  No history, no settings and no .env are included, so the
echo  rig keeps everything it already has.
echo ========================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0export_offline.ps1" -CodeOnly
if errorlevel 1 (
    echo.
    echo CODE UPDATE PACKAGE CREATION FAILED.
    pause
    exit /b 1
)

echo.
echo Code update package is ready.
pause
