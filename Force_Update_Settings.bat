@echo off
setlocal
cd /d "%~dp0"
title Force Update Settings
echo ========================================================
echo Forcing Rig Twin to use the latest exported settings...
echo.
echo WARNING: this DELETES this PC's users, PLC config, dashboard
echo layout, alarm settings, CMMS records, run hours and well
echo archive. InfluxDB history is NOT deleted.
echo.
echo For a normal software update use Update_Code_Only.bat instead.
echo ========================================================
echo.
set /p CONFIRM=Type YES to delete the settings database: 
if /i not "%CONFIRM%"=="YES" (
    echo Cancelled.
    pause
    exit /b 1
)

echo Stopping running containers...
docker compose -p ahwr-50-twin down

echo.
echo Clearing old settings database to allow fresh import...
docker volume rm ahwr-50-twin_backend_data

echo.
echo Restarting application with your new settings...
docker compose -p ahwr-50-twin up -d --no-build

echo.
echo ========================================================
echo Done! Please wait a moment and then refresh your browser.
echo ========================================================
echo.
pause
