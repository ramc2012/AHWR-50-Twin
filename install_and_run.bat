@echo off
setlocal
cd /d "%~dp0"
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

if not exist "certs\mcp.crt" (
    echo [ERROR] certs\mcp.crt is missing. The mcp-edge service cannot start without it.
    pause
    exit /b 1
)

echo Loading offline Docker images...
if exist "images\backend.tar" docker load -i images\backend.tar
if exist "images\frontend.tar" docker load -i images\frontend.tar
if exist "images\mcp-edge.tar" docker load -i images\mcp-edge.tar
if exist "images\influxdb.tar" docker load -i images\influxdb.tar
if exist "images\telegraf.tar" docker load -i images\telegraf.tar

echo.
echo Starting application...
REM --no-build: on an air-gapped PC a missing image must fail loudly here rather
REM than send Docker off to build mcp-edge/backend/frontend with no network.
docker compose -p ahwr-50-twin up -d --no-build
if errorlevel 1 (
    echo.
    echo [ERROR] Start failed. If Docker reported a missing image, the pendrive is
    echo missing one of the image tars above - re-run export_images.bat on the
    echo build PC and copy the images folder again.
    pause
    exit /b 1
)

echo.
echo =======================================================
echo Done! The application is starting in the background.
echo You can access it locally at http://localhost:8080
echo Or from another PC at http://[THIS_PC_IP]:8080
echo.
echo NOTE: If you cannot access it from another PC, please
echo ensure Windows Firewall allows incoming connections on port 8080
echo and that FRONTEND_BIND in .env is not 127.0.0.1.
echo =======================================================
pause
