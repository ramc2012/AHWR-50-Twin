@echo off
title Start Rig Twin Server
echo ========================================================
echo Starting ROM-II Digital Twin Server...
echo ========================================================
echo.
echo Bringing up Docker containers (this may take a moment)...
docker compose up -d --build
echo.
echo ========================================================
echo Success! The server is running in the background.
echo You can now access the dashboard at: http://localhost:8085
echo ========================================================
echo.
pause
