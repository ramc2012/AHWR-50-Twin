@echo off
title Force Update Settings
echo ========================================================
echo Forcing Rig Twin to use the latest exported settings...
echo ========================================================
echo.
echo Stopping running containers...
docker compose down

echo.
echo Clearing old settings database to allow fresh import...
docker volume rm ahwr-50-twin_backend_data

echo.
echo Restarting application with your new settings...
docker compose up -d

echo.
echo ========================================================
echo Done! Please wait a moment and then refresh your browser.
echo ========================================================
echo.
pause
