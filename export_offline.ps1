param(
    [string]$OutputFile = "",
    # Code + images only: no volume tars and no .env. Pairs with
    # import_offline.ps1 -KeepData for an on-site update that keeps rig history.
    [switch]$CodeOnly
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectName = 'ahwr-50-twin'

if (-not $OutputFile) {
    if ($CodeOnly) { $OutputFile = "AHWR-50-Twin_Code_Update.tar" }
    else           { $OutputFile = "AHWR-50-Twin_Full_Transfer.tar" }
}
$archivePath = Join-Path $projectRoot $OutputFile
$stageRoot   = Join-Path $env:TEMP "AHWR-50-Twin_Transfer_Stage"
$packageRoot = Join-Path $stageRoot "AHWR-50-Twin"

function Run-Step {
    param([string]$Message, [scriptblock]$Action)
    Write-Host $Message -ForegroundColor Cyan
    $global:LASTEXITCODE = 0
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Message failed with exit code $LASTEXITCODE"
    }
}

# mcp-edge mounts ./certs read-only and points TLS_CERT_FILE/TLS_KEY_FILE at it, so the
# container exits immediately on the rig without the pair. certs/ is .gitignore'd, so a
# package built from a fresh clone would otherwise ship a stack that cannot start.
foreach ($certFile in @('certs\mcp.crt', 'certs\mcp.key')) {
    if (!(Test-Path -LiteralPath (Join-Path $projectRoot $certFile))) {
        throw ("Missing $certFile - the mcp-edge service cannot start without it." + "`n" +
               "Generate a self-signed pair first, for example:" + "`n" +
               "  mkdir certs" + "`n" +
               "  openssl req -x509 -newkey rsa:2048 -nodes -days 1825 -keyout certs\mcp.key -out certs\mcp.crt -subj `"/CN=ahwr-edge-mcp`" -addext `"subjectAltName=DNS:localhost,IP:127.0.0.1`"")
    }
}

Write-Host "========================================================"
if ($CodeOnly) {
    Write-Host " Creating AHWR-50-Twin CODE UPDATE archive"
    Write-Host " Code + images only - no history, no settings, no .env"
} else {
    Write-Host " Creating complete AHWR-50-Twin transfer archive"
    Write-Host " Code + images + settings + users + history"
}
Write-Host "========================================================"

Push-Location $projectRoot
try {
    # mcp-edge is in the default profile with a build: context, so an air-gapped PC
    # would try to BUILD it (npm ci needs the network) unless it is shipped prebuilt.
    Run-Step "[1/8] Building current application images (backend, frontend, mcp-edge)..." {
        docker compose -p $ProjectName build backend frontend mcp-edge
    }

    if (!$CodeOnly) {
        Run-Step "[2/8] Stopping application for a consistent backup..." {
            docker compose -p $ProjectName stop
        }
    } else {
        Write-Host "[2/8] Stack left running - a code-only package copies no volumes." -ForegroundColor Yellow
    }

    if (Test-Path $stageRoot) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $packageRoot | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $packageRoot "docker_images") | Out-Null
    if (!$CodeOnly) {
        New-Item -ItemType Directory -Path (Join-Path $packageRoot "volume_backups") | Out-Null
    }

    Write-Host "[3/8] Copying project files..." -ForegroundColor Cyan
    $excludeDirs = @(
        ".git",
        "node_modules",
        "dist",
        "offline_images",
        "images",
        "docker_images",
        "volume_backups",
        "_preinstall_backups",
        "_full_transfer_stage",
        # The central CRMF stack is a separate deployment (~90 MB) and its own
        # central/.env holds live central secrets. A rig package must not carry it.
        "central"
    )
    $excludeFiles = @(
        "*.tar",
        "*.zip",
        "*.tgz",
        "*.gz"
    )
    if ($CodeOnly) {
        # Never ship the build machine's .env to a rig on a code-only update:
        # import_offline.ps1 -KeepData rebuilds .env from the rig's own containers.
        $excludeFiles += ".env"
    }
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
    $global:LASTEXITCODE = 0

    Run-Step "[4/8] Exporting Docker images..." {
        $imagesArchive = Join-Path $packageRoot "docker_images\images.tar"
        docker save -o $imagesArchive `
            influxdb:2.7 `
            telegraf:1.29 `
            ahwr-50-twin-backend:latest `
            ahwr-50-twin-frontend:latest `
            ahwr-50-twin-mcp-edge:latest
    }

    if (!$CodeOnly) {
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
    } else {
        Write-Host "[5/8] Skipping settings backup (code-only package)." -ForegroundColor Yellow
        Write-Host "[6/8] Skipping history backup (code-only package)." -ForegroundColor Yellow
    }

    if (Test-Path $archivePath) {
        Remove-Item -LiteralPath $archivePath -Force
    }

    Run-Step "[7/8] Creating single transfer archive..." {
        tar -cf $archivePath -C $stageRoot "AHWR-50-Twin"
    }

    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash
    Set-Content -LiteralPath "$archivePath.sha256" -Value "$hash  $OutputFile" -Encoding ASCII

    if (!$CodeOnly) {
        Write-Host "[8/8] Restarting application..." -ForegroundColor Cyan
        docker compose -p $ProjectName up -d --no-build
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Backup succeeded, but the application could not be restarted automatically."
        }
        $global:LASTEXITCODE = 0
    } else {
        Write-Host "[8/8] Nothing to restart." -ForegroundColor Yellow
    }

    $sizeGb = [math]::Round((Get-Item -LiteralPath $archivePath).Length / 1GB, 2)
    Write-Host ""
    Write-Host "SUCCESS" -ForegroundColor Green
    Write-Host "Archive: $archivePath"
    Write-Host "Size:    $sizeGb GB"
    Write-Host "SHA256:  $hash"
    Write-Host ""
    Write-Host "Copy the .tar and .sha256 files to the rig PC and extract the tar."
    if ($CodeOnly) {
        Write-Host "Then run:  Update_Code_Only.bat    (keeps the rig's history and settings)"
    } else {
        Write-Host "Then run:  Update_With_Current_Settings.bat   (replaces history and settings)"
        Write-Host ""
        Write-Host "WARNING: this archive contains .env with live secrets. Treat the pendrive" -ForegroundColor Yellow
        Write-Host "as a secret and erase it after the transfer." -ForegroundColor Yellow
    }
}
finally {
    Pop-Location
    if (Test-Path $stageRoot) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}
