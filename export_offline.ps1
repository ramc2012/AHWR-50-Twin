param(
    [string]$OutputFile = "AHWR-50-Twin_Full_Transfer.tar"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$archivePath = Join-Path $projectRoot $OutputFile
$stageRoot = Join-Path $env:TEMP "AHWR-50-Twin_Full_Transfer"
$packageRoot = Join-Path $stageRoot "AHWR-50-Twin"

function Run-Step {
    param([string]$Message, [scriptblock]$Action)
    Write-Host $Message -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Message failed with exit code $LASTEXITCODE"
    }
}

Write-Host "========================================================"
Write-Host " Creating complete AHWR-50-Twin transfer archive"
Write-Host " Code + images + settings + users + history"
Write-Host "========================================================"

Push-Location $projectRoot
try {
    Run-Step "[1/8] Building current application images..." {
        docker compose build backend frontend
    }

    Run-Step "[2/8] Stopping application for a consistent backup..." {
        docker compose stop
    }

    if (Test-Path $stageRoot) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $packageRoot | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $packageRoot "docker_images") | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $packageRoot "volume_backups") | Out-Null

    Write-Host "[3/8] Copying project files..." -ForegroundColor Cyan
    $excludeDirs = @(
        ".git",
        "node_modules",
        "dist",
        "offline_images",
        "images",
        "_full_transfer_stage"
    )
    $excludeFiles = @(
        "*.tar",
        "*.zip",
        "*.tgz",
        "*.gz"
    )
    $robocopyArgs = @(
        $projectRoot,
        $packageRoot,
        "/E",
        "/R:1",
        "/W:1",
        "/NFL",
        "/NDL",
        "/NJH",
        "/NJS",
        "/NP",
        "/XD"
    ) + $excludeDirs + @("/XF") + $excludeFiles
    & robocopy @robocopyArgs | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "Project copy failed with robocopy exit code $LASTEXITCODE"
    }

    Run-Step "[4/8] Exporting Docker images..." {
        $imagesArchive = Join-Path $packageRoot "docker_images\images.tar"
        docker save -o $imagesArchive `
            influxdb:2.7 `
            telegraf:1.29 `
            ahwr-50-twin-backend:latest `
            ahwr-50-twin-frontend:latest
    }

    Run-Step "[5/8] Backing up users and application settings..." {
        docker run --rm --user 0:0 --entrypoint sh `
            -v ahwr-50-twin_backend_data:/source:ro `
            -v "${packageRoot}:/backup" `
            ahwr-50-twin-backend:latest `
            -c "cd /source && tar -cf /backup/volume_backups/backend_data.tar ."
    }

    Run-Step "[6/8] Backing up InfluxDB historical data..." {
        docker run --rm --user 0:0 --entrypoint sh `
            -v ahwr-50-twin_influxdb_data:/source:ro `
            -v "${packageRoot}:/backup" `
            influxdb:2.7 `
            -c "cd /source && tar -cf /backup/volume_backups/influxdb_data.tar ."
    }

    if (Test-Path $archivePath) {
        Remove-Item -LiteralPath $archivePath -Force
    }

    Run-Step "[7/8] Creating single transfer archive..." {
        tar -cf $archivePath -C $stageRoot "AHWR-50-Twin"
    }

    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash
    Set-Content -LiteralPath "$archivePath.sha256" -Value "$hash  $OutputFile" -Encoding ASCII

    Write-Host "[8/8] Restarting application..." -ForegroundColor Cyan
    docker compose up -d
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Backup succeeded, but the application could not be restarted automatically."
    }

    $sizeGb = [math]::Round((Get-Item -LiteralPath $archivePath).Length / 1GB, 2)
    Write-Host ""
    Write-Host "SUCCESS" -ForegroundColor Green
    Write-Host "Archive: $archivePath"
    Write-Host "Size:    $sizeGb GB"
    Write-Host "SHA256:  $hash"
    Write-Host ""
    Write-Host "Copy the .tar and .sha256 files to the other PC."
    Write-Host "Extract the tar, then run Restore_Full_Transfer.bat."
}
finally {
    Pop-Location
    if (Test-Path $stageRoot) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}
