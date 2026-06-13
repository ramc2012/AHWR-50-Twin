@echo off
echo =======================================================
echo    ROM-II Twin Offline Installer ^& Launcher
echo =======================================================
echo.

echo Checking for Docker...
docker --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Docker is not installed or not running.
    echo Please install Docker Desktop and start it before running this script.
    pause
    exit /b 1
)

echo Loading offline Docker images...
if exist "images\backend.tar" docker load -i images\backend.tar
if exist "images\frontend.tar" docker load -i images\frontend.tar
if exist "images\influxdb.tar" docker load -i images\influxdb.tar
if exist "images\telegraf.tar" docker load -i images\telegraf.tar

echo.
echo Starting application...
docker compose up -d

echo.
echo =======================================================
echo Done! The application is starting in the background.
echo You can access it locally at http://localhost:8085
echo Or from another PC at http://[THIS_PC_IP]:8085
echo.
echo NOTE: If you cannot access it from another PC, please 
echo ensure Windows Firewall allows incoming connections on port 8085.
echo =======================================================
pause
