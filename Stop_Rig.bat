@echo off
title Stop Rig Twin Server
echo ========================================================
echo Stopping ROM-II Digital Twin Server...
echo ========================================================
echo.
docker compose -p ahwr-50-twin down
echo.
echo ========================================================
echo Success! The server has been stopped.
echo ========================================================
echo.
pause
