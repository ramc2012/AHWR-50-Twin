@echo off
setlocal
title Update AHWR-50-Twin Code (Keep Data)
cd /d "%~dp0"

echo ========================================================
echo  Updating AHWR-50-Twin application code and images
echo.
echo  KEPT on this PC:
echo    - InfluxDB history
echo    - users and passwords
echo    - PLC config, dashboard layout, variables, alarm settings
echo    - CMMS work orders, logbook, overhauls, run hours
echo    - well archive and well reports
echo    - this PC's .env (Influx token, device id, LDAP, MCP keys)
echo ========================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0import_offline.ps1" -KeepData
if errorlevel 1 (
    echo.
    echo UPDATE FAILED.
    pause
    exit /b 1
)

echo.
echo Update completed successfully.
pause
