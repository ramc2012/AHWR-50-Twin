@echo off
setlocal
title Update AHWR-50-Twin Code + Settings from package
cd /d "%~dp0"

echo ========================================================
echo  FULL RESTORE from this transfer package
echo.
echo  This REPLACES everything currently on this PC with the
echo  settings and history exported from the source PC:
echo    - PLC / S7 settings
echo    - users and passwords
echo    - active/running well state
echo    - dashboard layout, variables, alarm settings
echo    - InfluxDB token and history from the package
echo.
echo  A safety copy of this PC's current volumes is written to
echo  _preinstall_backups\ before anything is replaced.
echo ========================================================
echo.
set /p CONFIRM=Type YES to replace this PC's data: 
if /i not "%CONFIRM%"=="YES" (
    echo Cancelled.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0import_offline.ps1"
if errorlevel 1 (
    echo.
    echo UPDATE FAILED.
    pause
    exit /b 1
)

echo.
echo Update with package settings completed successfully.
pause
