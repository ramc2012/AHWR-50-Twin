@echo off
setlocal
cd /d "%~dp0"
echo ==========================================
echo Initializing ROM-II Digital Twin
echo ==========================================
echo.
echo Loading Docker Images from offline cache...
echo This may take a few minutes depending on disk speed. Please wait...
echo.

if not exist "offline_images" (
    echo ERROR: 'offline_images' folder not found!
    echo Please make sure you copied the entire Ahwr-50-Twin folder.
    pause
    exit /b 1
)

echo [1/5] Loading InfluxDB image...
docker load -i offline_images\influxdb.tar

echo [2/5] Loading Telegraf image...
docker load -i offline_images\telegraf.tar

echo [3/5] Loading ROM-II Backend image...
docker load -i offline_images\ahwr-50-twin-backend.tar

echo [4/5] Loading ROM-II Frontend image...
docker load -i offline_images\ahwr-50-twin-frontend.tar

REM mcp-edge is in the DEFAULT compose profile with a build: context - without this
REM image `docker compose up -d` would try to build it and fail with no network.
echo [5/5] Loading Edge MCP server image...
docker load -i offline_images\ahwr-50-twin-mcp-edge.tar

echo.
echo ==========================================
echo Starting the Application...
echo ==========================================
docker compose -p ahwr-50-twin up -d --no-build
if errorlevel 1 (
    echo.
    echo [ERROR] Start failed - see the message above. A "pull access denied" or
    echo "image not found" error means an image tar is missing from offline_images.
    pause
    exit /b 1
)

echo.
echo ==========================================
echo Application Started! Opening in Browser...
echo ==========================================
timeout /t 4 /nobreak > nul
start http://localhost:8080

echo.
echo Done! The app is running in the background.
echo Local PC: http://localhost:8080
echo You can safely close this window.
pause
