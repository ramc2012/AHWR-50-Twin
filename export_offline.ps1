Write-Host "=========================================="
Write-Host "Exporting ROM-II Digital Twin for Offline"
Write-Host "=========================================="
Write-Host ""
Write-Host "This will save all necessary Docker images to .tar files."
Write-Host "It may take a few minutes depending on your disk speed..."
Write-Host ""

mkdir -Force offline_images | Out-Null

Write-Host "[1/4] Saving InfluxDB image..."
docker save -o offline_images/influxdb.tar influxdb:2.7

Write-Host "[2/4] Saving Telegraf image..."
docker save -o offline_images/telegraf.tar telegraf:1.29

Write-Host "[3/4] Saving ROM-II Backend image..."
docker save -o offline_images/ahwr-50-twin-backend.tar ahwr-50-twin-backend:latest

Write-Host "[4/4] Saving ROM-II Frontend image..."
docker save -o offline_images/ahwr-50-twin-frontend.tar ahwr-50-twin-frontend:latest

Write-Host ""
Write-Host "=========================================="
Write-Host "SUCCESS! All images exported to 'offline_images' folder."
Write-Host "=========================================="
Write-Host "To transfer to another PC:"
Write-Host "1. Copy this entire 'Ahwr-50-Twin' folder to your pendrive."
Write-Host "2. On the offline PC, copy the folder to the hard drive."
Write-Host "3. Run 'import_offline.ps1' on the new PC to load the images."
Write-Host "4. Run 'docker compose up -d' to start the application."
Write-Host "=========================================="
pause
