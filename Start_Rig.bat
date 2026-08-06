@echo off
setlocal
cd /d "%~dp0"
title Start Rig Twin Server
echo ========================================================
echo Starting ROM-II Digital Twin Server...
echo ========================================================
echo.
echo Bringing up Docker containers (this may take a moment)...
REM --no-build on purpose: this script runs on the rig PC, which has no internet.
REM `--build` here would try to rebuild backend/frontend/mcp-edge from source
REM (npm ci) and fail. Images arrive prebuilt via the offline package.
docker compose -p ahwr-50-twin up -d --no-build
if errorlevel 1 (
    echo.
    echo [ERROR] Start failed. If Docker says an image is missing, run the offline
    echo update package again (Update_Code_Only.bat) to load the images.
    pause
    exit /b 1
)
echo.
echo ========================================================
echo Success! The server is running in the background.
echo Dashboard: http://localhost:8080
echo ========================================================
echo.
pause
