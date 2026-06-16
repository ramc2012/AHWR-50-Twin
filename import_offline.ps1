$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Run-Step {
    param([string]$Message, [scriptblock]$Action)
    Write-Host $Message -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Message failed with exit code $LASTEXITCODE"
    }
}

Push-Location $projectRoot
try {
    $imagesArchive = Join-Path $projectRoot "docker_images\images.tar"
    $backendBackup = Join-Path $projectRoot "volume_backups\backend_data.tar"
    $influxBackup = Join-Path $projectRoot "volume_backups\influxdb_data.tar"

    foreach ($requiredFile in @($imagesArchive, $backendBackup, $influxBackup, (Join-Path $projectRoot ".env"))) {
        if (!(Test-Path -LiteralPath $requiredFile)) {
            throw "Required transfer file is missing: $requiredFile"
        }
    }

    Write-Host "========================================================"
    Write-Host " Restoring complete AHWR-50-Twin installation"
    Write-Host "========================================================"

    Run-Step "[1/6] Loading Docker images..." {
        docker load -i $imagesArchive
    }

    docker compose down

    Run-Step "[2/6] Creating application volumes..." {
        docker volume create ahwr-50-twin_backend_data
        docker volume create ahwr-50-twin_influxdb_data
    }

    Run-Step "[3/6] Restoring users and application settings..." {
        docker run --rm --user 0:0 --entrypoint sh `
            -v ahwr-50-twin_backend_data:/target `
            -v "${projectRoot}:/backup:ro" `
            ahwr-50-twin-backend:latest `
            -c "rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null || true; cd /target && tar -xf /backup/volume_backups/backend_data.tar && chown -R 1000:1000 /target"
    }

    Run-Step "[4/6] Restoring InfluxDB historical data..." {
        docker run --rm --user 0:0 --entrypoint sh `
            -v ahwr-50-twin_influxdb_data:/target `
            -v "${projectRoot}:/backup:ro" `
            influxdb:2.7 `
            -c "rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null || true; cd /target && tar -xf /backup/volume_backups/influxdb_data.tar"
    }

    Run-Step "[5/6] Starting application..." {
        docker compose up -d
    }

    Write-Host "[6/6] Checking containers..." -ForegroundColor Cyan
    docker compose ps

    Write-Host ""
    Write-Host "SUCCESS: Code, images, users, settings and history were restored." -ForegroundColor Green
    Write-Host "Open: http://localhost:8085"
}
finally {
    Pop-Location
}
