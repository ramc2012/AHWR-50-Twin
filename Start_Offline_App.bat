@echo off
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
    exit /b
)

echo [1/4] Loading InfluxDB image...
docker load -i offline_images\influxdb.tar

echo [2/4] Loading Telegraf image...
docker load -i offline_images\telegraf.tar

echo [3/4] Loading ROM-II Backend image...
docker load -i offline_images\ahwr-50-twin-backend.tar

echo [4/4] Loading ROM-II Frontend image...
docker load -i offline_images\ahwr-50-twin-frontend.tar

echo.
echo ==========================================
echo Starting the Application...
echo ==========================================
docker compose up -d

echo.
echo ==========================================
echo Application Started! Opening in Browser...
echo ==========================================
timeout /t 4 /nobreak > nul
start http://localhost:8085

echo.
echo Done! The app is running in the background.
echo You can safely close this window.
pause
