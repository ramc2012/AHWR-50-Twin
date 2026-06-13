Write-Host "=========================================="
Write-Host "Importing ROM-II Digital Twin from Offline"
Write-Host "=========================================="
Write-Host ""
Write-Host "This will load all necessary Docker images from the 'offline_images' folder."
Write-Host "It may take a few minutes depending on your disk speed..."
Write-Host ""

if (!(Test-Path "offline_images")) {
    Write-Host "ERROR: 'offline_images' folder not found!"
    Write-Host "Make sure you copied the entire Ahwr-50-Twin folder from the pendrive."
    pause
    exit
}

Write-Host "[1/4] Loading InfluxDB image..."
docker load -i offline_images/influxdb.tar

Write-Host "[2/4] Loading Telegraf image..."
docker load -i offline_images/telegraf.tar

Write-Host "[3/4] Loading ROM-II Backend image..."
docker load -i offline_images/ahwr-50-twin-backend.tar

Write-Host "[4/4] Loading ROM-II Frontend image..."
docker load -i offline_images/ahwr-50-twin-frontend.tar

Write-Host ""
Write-Host "=========================================="
Write-Host "SUCCESS! All images loaded into Docker."
Write-Host "=========================================="
Write-Host "You can now start the application by running:"
Write-Host "docker compose up -d"
Write-Host "=========================================="
pause
