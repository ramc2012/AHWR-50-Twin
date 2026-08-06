param(
    # Code-only update: keep this PC's existing InfluxDB history, users, CMMS records,
    # well archive, alarm settings and .env. Only docker_images\images.tar is required.
    [switch]$KeepData,
    # Skip the safety copy of this PC's volumes taken just before a full restore wipes them.
    [switch]$NoBackup,
    # Load images / restore volumes but do not start the stack.
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:ExitCode = 0
$script:RigEnv = $null

# --- Names -------------------------------------------------------------------
# docker-compose.yml pins `name: ahwr-50-twin` and every compose call below repeats
# -p, so these hold no matter what the extracted folder is called.
$ProjectName   = 'ahwr-50-twin'
$BackendVolume = 'ahwr-50-twin_backend_data'
$InfluxVolume  = 'ahwr-50-twin_influxdb_data'
$BackendImage  = 'ahwr-50-twin-backend:latest'
$InfluxImage   = 'influxdb:2.7'

# container_name: values from docker-compose.yml (default profile, then demo profile).
$AppContainers    = @('AHWR_frontend','AHWR_backend','AHWR_mcp_edge','AHWR_telegraf','AHWR_influxdb')
$DemoContainers   = @('AHWR_mock','AHWR_opc_plc','AHWR_telegraf_opcua','AHWR_openldap','AHWR_sync_sink','AHWR_etp_sink')
# Names used by installations made before the AHWR_* container_name rename.
$LegacyContainers = @('ahwr-50-twin-frontend','ahwr-50-twin-backend','ahwr-50-twin-telegraf','ahwr-50-twin-influxdb',
                      'romii_frontend','romii_backend','romii_telegraf','romii_influxdb')

# Operator-owned settings. Everything else in .env is derived or static.
$PreserveKeys = @(
    'INFLUX_USERNAME','INFLUX_PASSWORD','INFLUX_ORG','INFLUX_BUCKET','INFLUX_RETENTION','INFLUX_TOKEN',
    'JWT_SECRET','ADMIN_USERNAME','ADMIN_PASSWORD','DATA_SOURCE','CORS_ORIGIN',
    'FRONTEND_BIND','FRONTEND_PORT','MOCK_INTERVAL_MS',
    'MCP_BACKEND_TOKEN','MCP_AUTH_MODE','MCP_API_KEY','MCP_API_KEY_ID','MCP_API_KEYS_JSON',
    'MCP_ALLOWED_HOSTS','MCP_ALLOWED_ORIGINS','MCP_RATE_LIMIT_PER_MINUTE','MCP_TRUST_PROXY',
    'MCP_PUBLIC_URL','MCP_OAUTH_ISSUER','MCP_OAUTH_AUDIENCE','MCP_OAUTH_JWKS_URL','MCP_OAUTH_SCOPES',
    'MCP_EDGE_BIND','MCP_EDGE_PORT',
    'AUTH_MODE','LDAP_URL','LDAP_BIND_DN','LDAP_BIND_PASSWORD','LDAP_SEARCH_BASE','LDAP_SEARCH_FILTER',
    'LDAP_DOMAIN','LDAP_DEFAULT_ROLE','LDAP_ROLE_ADMIN','LDAP_ROLE_OPERATOR','LDAP_ROLE_VIEWER',
    'LDAP_STARTTLS','LDAP_TLS_REJECT_UNAUTHORIZED',
    'SYNC_ENABLED','CENTRAL_URL','DEVICE_ID','DEVICE_TOKEN','SYNC_BATCH_SECONDS','SYNC_BUFFER_DAYS',
    'ETP_ENABLED','ETP_URL','ETP_STREAM_SECONDS'
)

# The influxdb container exposes these ONLY under their DOCKER_INFLUXDB_INIT_* names,
# so without this map INFLUX_PASSWORD / INFLUX_USERNAME / INFLUX_RETENTION are lost on
# every update and replaced by whatever the package shipped.
$InfluxAliases = @{
    'DOCKER_INFLUXDB_INIT_USERNAME'    = 'INFLUX_USERNAME'
    'DOCKER_INFLUXDB_INIT_PASSWORD'    = 'INFLUX_PASSWORD'
    'DOCKER_INFLUXDB_INIT_ORG'         = 'INFLUX_ORG'
    'DOCKER_INFLUXDB_INIT_BUCKET'      = 'INFLUX_BUCKET'
    'DOCKER_INFLUXDB_INIT_RETENTION'   = 'INFLUX_RETENTION'
    'DOCKER_INFLUXDB_INIT_ADMIN_TOKEN' = 'INFLUX_TOKEN'
}

# --- Helpers -----------------------------------------------------------------

function Run-Step {
    param([string]$Message, [scriptblock]$Action)
    Write-Host $Message -ForegroundColor Cyan
    $global:LASTEXITCODE = 0
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Message failed with exit code $LASTEXITCODE"
    }
}

function Test-DockerVolume {
    param([string]$Name)
    & docker volume inspect $Name *> $null
    return ($LASTEXITCODE -eq 0)
}

function New-Secret {
    param([int]$Bytes = 32)
    $buf = New-Object 'byte[]' $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buf) } finally { $rng.Dispose() }
    return (($buf | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Read-EnvFile {
    param([string]$Path)
    $values = [ordered]@{}
    if (Test-Path -LiteralPath $Path) {
        foreach ($line in (Get-Content -LiteralPath $Path)) {
            if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
            $parts = $line -split '=', 2
            $key = $parts[0].Trim()
            if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }
            $raw = $parts[1]
            if ($raw -match '^\s*"(.*)"\s*$') {
                $val = $Matches[1] -replace '\\"', '"'
            } elseif ($raw -match "^\s*'(.*)'\s*$") {
                $val = $Matches[1]
            } else {
                # Docker Compose strips a whitespace-preceded inline comment from an
                # unquoted value; do the same so the annotations in .env.example do not
                # get baked into the rig's real settings.
                $val = ($raw -replace '\s+#.*$', '').Trim()
            }
            $values[$key] = $val
        }
    }
    return $values
}

function Write-EnvFile {
    param([string]$Path, $Values)
    $lines = @(
        '# AHWR-50 Twin runtime settings.',
        '# Written by import_offline.ps1. Values recovered from THIS PC always win over',
        '# anything shipped in the update package. Contains live secrets - do not copy off the rig.',
        ('# Last written: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    )
    foreach ($key in @($Values.Keys)) {
        $val = [string]$Values[$key]
        if ($val -match '[\s#"'']') {
            if ($val -notmatch "'") {
                $val = "'" + $val + "'"
            } else {
                $val = '"' + ($val -replace '\\', '\\' -replace '"', '\"') + '"'
            }
        }
        $lines += "$key=$val"
    }
    # UTF-8 without BOM on both Windows PowerShell 5.1 and PowerShell 7.
    [System.IO.File]::WriteAllLines($Path, $lines, (New-Object System.Text.UTF8Encoding($false)))
}

# Read the settings this PC is ACTUALLY running with, straight out of the containers.
# This is the only source that survives an update package being extracted on top of the
# live folder (which overwrites .env with the build machine's copy).
function Get-ContainerEnvValues {
    param([string[]]$Containers)
    $found = [ordered]@{}
    $existing = @(& docker ps -a --format '{{.Names}}' 2>$null)
    foreach ($container in $Containers) {
        if ($existing -notcontains $container) { continue }
        $envLines = @(& docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $container 2>$null)
        foreach ($line in $envLines) {
            if ($line -notmatch '=') { continue }
            $parts = $line -split '=', 2
            $key = $parts[0].Trim()
            if ($InfluxAliases.ContainsKey($key)) { $key = $InfluxAliases[$key] }
            if ($PreserveKeys -notcontains $key) { continue }
            $found[$key] = $parts[1]
        }
    }
    return $found
}

function Get-PortBinding {
    param([string]$Container, [string]$Port)
    try {
        $raw = & docker inspect $Container 2>$null
        if (!$raw) { return $null }
        $info = $raw | ConvertFrom-Json
        $binding = $info[0].HostConfig.PortBindings.$Port | Select-Object -First 1
        if (!$binding) { return $null }
        return @{ Ip = $binding.HostIp; Port = $binding.HostPort }
    } catch {
        return $null
    }
}

# Fallback for the case where the operator ran Stop_Rig.bat / `docker compose down`
# before updating, so no containers are left to inspect. Written by Save-EnvSnapshot
# at the end of every successful run.
function Get-VolumeEnvSnapshot {
    if (!(Test-DockerVolume $BackendVolume)) { return $null }
    $tmp = Join-Path $env:TEMP ("ahwr-rig-env-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $global:LASTEXITCODE = 0
        & docker run --rm --user 0:0 --entrypoint sh `
            -v "${BackendVolume}:/data:ro" `
            -v "${tmp}:/out" `
            $InfluxImage `
            -c "if [ -f /data/.rig-env ]; then cp /data/.rig-env /out/rig.env; fi" *> $null
        $global:LASTEXITCODE = 0
        $snap = Join-Path $tmp 'rig.env'
        if (Test-Path -LiteralPath $snap) { return (Read-EnvFile -Path $snap) }
        return $null
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Save-EnvSnapshot {
    param([string]$EnvPath)
    if (!(Test-DockerVolume $BackendVolume)) { return }
    if (!(Test-Path -LiteralPath $EnvPath)) { return }
    $global:LASTEXITCODE = 0
    & docker run --rm --user 0:0 --entrypoint sh `
        -v "${BackendVolume}:/data" `
        -v "${projectRoot}:/host:ro" `
        $InfluxImage `
        -c "cp /host/.env /data/.rig-env && chmod 600 /data/.rig-env && chown 1000:1000 /data/.rig-env" *> $null
    $global:LASTEXITCODE = 0
}

function Ensure-Secret {
    param($Values, [string]$Key, [int]$MinLength, [int]$Bytes, [ref]$Generated)
    $cur = [string]$Values[$Key]
    if ($cur.Length -ge $MinLength) { return }
    $Values[$Key] = New-Secret -Bytes $Bytes
    $Generated.Value += $Key
}

function Set-IfBlank {
    param($Values, [string]$Key, [string]$Default)
    if (-not ([string]$Values[$Key])) { $Values[$Key] = $Default }
}

# Build the rig's .env: package template first, then everything recovered from this PC
# on top. MUST run before `docker compose down` - down removes the containers we read.
function Resolve-RigEnv {
    param([string]$EnvPath)

    $templatePath = $EnvPath
    if (!(Test-Path -LiteralPath $EnvPath)) {
        $templatePath = Join-Path $projectRoot '.env.example'
        if (!(Test-Path -LiteralPath $templatePath)) {
            throw "Neither .env nor .env.example is present in $projectRoot."
        }
        Write-Host "        No .env in this package; using .env.example only for the key list." -ForegroundColor Yellow
    }
    $values = Read-EnvFile -Path $templatePath

    # Placeholders from .env.example are non-empty, so compose's ${VAR:?} guards would
    # happily start the stack with CHANGE_ME_influx_admin_token. Treat them as blank.
    foreach ($k in @($values.Keys)) {
        if (([string]$values[$k]) -like 'CHANGE_ME*') { $values[$k] = '' }
    }

    $recovered = [ordered]@{}
    $snapshot = Get-VolumeEnvSnapshot
    if ($snapshot) {
        foreach ($k in @($snapshot.Keys)) {
            if ($PreserveKeys -contains $k) { $recovered[$k] = $snapshot[$k] }
        }
    }
    $fromContainers = Get-ContainerEnvValues -Containers ($AppContainers + $DemoContainers + $LegacyContainers)
    foreach ($k in @($fromContainers.Keys)) { $recovered[$k] = $fromContainers[$k] }

    if ($recovered.Count -gt 0) {
        Write-Host ("        Recovered " + $recovered.Count + " settings from this PC's existing installation.") -ForegroundColor Yellow
    } else {
        Write-Host "        No previous installation found on this PC; using the package settings." -ForegroundColor Yellow
    }
    foreach ($k in @($recovered.Keys)) { $values[$k] = $recovered[$k] }

    # Published ports are compose-level, not container env - read them off the bindings.
    $fe = Get-PortBinding -Container 'AHWR_frontend' -Port '80/tcp'
    if ($fe) {
        if ($fe.Ip)   { $values['FRONTEND_BIND'] = $fe.Ip }
        if ($fe.Port) { $values['FRONTEND_PORT'] = $fe.Port }
    }
    $mcp = Get-PortBinding -Container 'AHWR_mcp_edge' -Port '3000/tcp'
    if ($mcp) {
        if ($mcp.Ip)   { $values['MCP_EDGE_BIND'] = $mcp.Ip }
        if ($mcp.Port) { $values['MCP_EDGE_PORT'] = $mcp.Port }
    }

    Set-IfBlank $values 'FRONTEND_BIND'   '127.0.0.1'
    Set-IfBlank $values 'FRONTEND_PORT'   '8080'
    Set-IfBlank $values 'MCP_EDGE_BIND'   '127.0.0.1'
    Set-IfBlank $values 'MCP_EDGE_PORT'   '8765'
    Set-IfBlank $values 'DATA_SOURCE'     'plc'
    Set-IfBlank $values 'INFLUX_USERNAME' 'admin'
    Set-IfBlank $values 'INFLUX_ORG'      'romii_org'
    Set-IfBlank $values 'INFLUX_BUCKET'   'romii_bucket'
    Set-IfBlank $values 'INFLUX_RETENTION' '90d'
    Set-IfBlank $values 'ADMIN_USERNAME'  'admin'
    Set-IfBlank $values 'MCP_AUTH_MODE'   'api-key'

    $influxExists = Test-DockerVolume $InfluxVolume
    $generated = @()

    # INFLUX_TOKEN is baked into the historian volume at first init and can never be
    # rotated from the outside. Inventing one here is exactly the bug that locks the
    # backend and Telegraf out of their own history, so refuse instead.
    if (-not ([string]$values['INFLUX_TOKEN'])) {
        if ($KeepData -and $influxExists) {
            throw ("FATAL: this PC's INFLUX_TOKEN could not be recovered, and -KeepData means the" + "`n" +
                   "existing historian volume ($InfluxVolume) is being kept." + "`n" +
                   "Writing a new token would lock the backend and Telegraf out of the existing history." + "`n`n" +
                   "Do one of these, then run the update again:" + "`n" +
                   "  1. Start the current installation once (Start_Rig.bat) so its containers exist -" + "`n" +
                   "     the token is then read back from them automatically; or" + "`n" +
                   "  2. Copy the rig's original .env into this folder, next to import_offline.ps1; or" + "`n" +
                   "  3. Run a full restore (Update_With_Current_Settings.bat), which replaces the" + "`n" +
                   "     historian with the one in volume_backups\influxdb_data.tar.")
        }
        if (-not $KeepData) {
            throw ("FATAL: this package has no INFLUX_TOKEN." + "`n" +
                   "A full restore re-creates the historian from volume_backups\influxdb_data.tar," + "`n" +
                   "which only accepts the token it was originally created with. Rebuild the package" + "`n" +
                   "with export_offline.ps1 (it ships .env alongside the volume tars).")
        }
        $values['INFLUX_TOKEN'] = New-Secret -Bytes 24
        $generated += 'INFLUX_TOKEN'
    }

    # Safe to mint: nothing persisted depends on these values.
    Ensure-Secret -Values $values -Key 'JWT_SECRET'        -MinLength 16 -Bytes 32 -Generated ([ref]$generated)
    Ensure-Secret -Values $values -Key 'MCP_BACKEND_TOKEN' -MinLength 32 -Bytes 32 -Generated ([ref]$generated)
    if (($values['MCP_AUTH_MODE'] -ne 'oauth') -and (-not ([string]$values['MCP_API_KEYS_JSON']))) {
        Ensure-Secret -Values $values -Key 'MCP_API_KEY' -MinLength 16 -Bytes 32 -Generated ([ref]$generated)
    }
    # Only ever used to seed users.json on a brand-new install; inert once users exist.
    Ensure-Secret -Values $values -Key 'ADMIN_PASSWORD'  -MinLength 1 -Bytes 12 -Generated ([ref]$generated)
    # Only ever used at first init of the historian volume.
    Ensure-Secret -Values $values -Key 'INFLUX_PASSWORD' -MinLength 1 -Bytes 12 -Generated ([ref]$generated)

    if ($generated.Count -gt 0) {
        Write-Host ""
        Write-Host "        Generated missing secrets: $($generated -join ', ')" -ForegroundColor Yellow
        if ($generated -contains 'JWT_SECRET') {
            Write-Host "        JWT_SECRET changed - everyone must sign in again." -ForegroundColor Yellow
        }
        if ($generated -contains 'MCP_API_KEY') {
            Write-Host "        New MCP client API key: $($values['MCP_API_KEY'])" -ForegroundColor Yellow
            Write-Host "        Re-point any AI/MCP client at this key." -ForegroundColor Yellow
        }
        if ((-not $KeepData) -or (-not (Test-DockerVolume $BackendVolume))) {
            if ($generated -contains 'ADMIN_PASSWORD') {
                Write-Host "        Initial admin password: $($values['ADMIN_PASSWORD'])" -ForegroundColor Yellow
            }
        }
    }

    Write-EnvFile -Path $EnvPath -Values $values
    $script:RigEnv = $values
}

# Prove the backend can actually talk to the historian with the token we just wrote.
# Turns the silent lockout into a loud, actionable failure.
function Wait-InfluxToken {
    param([string]$Token, [string]$Org, [int]$TimeoutSeconds = 150)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $global:LASTEXITCODE = 0
        & docker exec -e "INFLUX_TOKEN=$Token" AHWR_influxdb influx bucket list --org $Org *> $null
        if ($LASTEXITCODE -eq 0) { $global:LASTEXITCODE = 0; return $true }
        Start-Sleep -Seconds 5
    }
    $global:LASTEXITCODE = 0
    return $false
}

# --- Main --------------------------------------------------------------------

Push-Location $projectRoot
try {
    $imagesArchive = Join-Path $projectRoot "docker_images\images.tar"
    $backendBackup = Join-Path $projectRoot "volume_backups\backend_data.tar"
    $influxBackup  = Join-Path $projectRoot "volume_backups\influxdb_data.tar"
    $envPath       = Join-Path $projectRoot ".env"

    # A code-only update needs nothing but the images: no volume tars (they would be
    # ignored) and no .env (this PC's own settings are recovered instead).
    $requiredFiles = @($imagesArchive)
    if (!$KeepData) {
        $requiredFiles += @($backendBackup, $influxBackup, $envPath)
    }
    foreach ($requiredFile in $requiredFiles) {
        if (!(Test-Path -LiteralPath $requiredFile)) {
            throw "Required transfer file is missing: $requiredFile"
        }
    }

    # mcp-edge mounts ./certs read-only and points TLS_CERT_FILE/TLS_KEY_FILE at it,
    # so it exits immediately if the pair is absent.
    foreach ($certFile in @('certs\mcp.crt', 'certs\mcp.key')) {
        if (!(Test-Path -LiteralPath (Join-Path $projectRoot $certFile))) {
            throw ("Required file is missing: $certFile" + "`n" +
                   "The mcp-edge service mounts ./certs read-only and cannot start without it." + "`n" +
                   "Rebuild the package with export_offline.ps1, which refuses to build without certs.")
        }
    }

    Write-Host "========================================================"
    if ($KeepData) {
        Write-Host " Updating AHWR-50-Twin CODE AND IMAGES ONLY"
        Write-Host " History, users, settings and .env on this PC are kept"
    } else {
        Write-Host " Restoring COMPLETE AHWR-50-Twin installation"
        Write-Host " This PC's history and settings will be REPLACED"
    }
    Write-Host "========================================================"

    Run-Step "[1/8] Loading Docker images..." {
        docker load -i $imagesArchive
    }

    # Before any `compose down`: down removes the containers we read settings from.
    Write-Host "[2/8] Reading this PC's current settings..." -ForegroundColor Cyan
    Resolve-RigEnv -EnvPath $envPath

    Write-Host "[3/8] Removing old AHWR containers..." -ForegroundColor Cyan
    docker compose -p $ProjectName down --remove-orphans
    $global:LASTEXITCODE = 0
    $existing = @(docker ps -a --format "{{.Names}}")
    $stale = @($AppContainers + $DemoContainers + $LegacyContainers | Where-Object { $existing -contains $_ })
    if ($stale.Count -gt 0) {
        docker rm -f @stale | Out-Null
    }
    $global:LASTEXITCODE = 0

    Run-Step "[4/8] Ensuring application volumes exist..." {
        docker volume create $BackendVolume | Out-Null
        docker volume create $InfluxVolume | Out-Null
    }

    if (!$KeepData -and !$NoBackup) {
        $backupDir = Join-Path $projectRoot ("_preinstall_backups\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
        Run-Step "[5/8] Safety copy of this PC's current data before it is replaced..." {
            docker run --rm --user 0:0 --entrypoint sh `
                -v "${BackendVolume}:/source:ro" `
                -v "${backupDir}:/backup" `
                $InfluxImage `
                -c "cd /source && tar -cf /backup/backend_data.tar ."
        }
        Run-Step "      ...and of the current history..." {
            docker run --rm --user 0:0 --entrypoint sh `
                -v "${InfluxVolume}:/source:ro" `
                -v "${backupDir}:/backup" `
                $InfluxImage `
                -c "cd /source && tar -cf /backup/influxdb_data.tar ."
        }
        Write-Host "      Saved to $backupDir" -ForegroundColor Yellow
    } elseif (!$KeepData) {
        Write-Host "[5/8] Pre-update safety backup skipped (-NoBackup)." -ForegroundColor Yellow
    } else {
        Write-Host "[5/8] No safety backup needed - nothing is being wiped (-KeepData)." -ForegroundColor Yellow
    }

    if (!$KeepData) {
        Run-Step "[6/8] Restoring users and application settings..." {
            docker run --rm --user 0:0 --entrypoint sh `
                -v "${BackendVolume}:/target" `
                -v "${projectRoot}:/backup:ro" `
                $BackendImage `
                -c "rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null || true; cd /target && tar -xf /backup/volume_backups/backend_data.tar && chown -R 1000:1000 /target"
        }
        Run-Step "[7/8] Restoring InfluxDB historical data..." {
            docker run --rm --user 0:0 --entrypoint sh `
                -v "${InfluxVolume}:/target" `
                -v "${projectRoot}:/backup:ro" `
                $InfluxImage `
                -c "rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null || true; cd /target && tar -xf /backup/volume_backups/influxdb_data.tar"
        }
    } else {
        Write-Host "[6/8] Keeping existing users, settings, CMMS records, run hours and well archive." -ForegroundColor Yellow
        Write-Host "[7/8] Keeping existing InfluxDB history." -ForegroundColor Yellow
    }

    # Makes the settings recoverable next time even if the operator shuts the stack
    # down before running the update.
    Save-EnvSnapshot -EnvPath $envPath

    if ($NoStart) {
        Write-Host ""
        Write-Host "Installed but not started (-NoStart)." -ForegroundColor Yellow
    } else {
        Run-Step "[8/8] Starting application..." {
            docker compose -p $ProjectName up -d --force-recreate --no-build
        }
        docker compose -p $ProjectName ps
        $global:LASTEXITCODE = 0

        Write-Host ""
        Write-Host "Verifying the backend can reach the historian with this .env..." -ForegroundColor Cyan
        $tokenOk = Wait-InfluxToken -Token ([string]$script:RigEnv['INFLUX_TOKEN']) -Org ([string]$script:RigEnv['INFLUX_ORG'])
        if (-not $tokenOk) {
            Write-Host ""
            Write-Host "FAILED: InfluxDB rejected the token in .env." -ForegroundColor Red
            Write-Host "Your data is intact - the stack is simply authenticating with the wrong token." -ForegroundColor Red
            Write-Host "Put the rig's original .env back in this folder and re-run, or run" -ForegroundColor Red
            Write-Host "Update_With_Current_Settings.bat to restore the matching historian." -ForegroundColor Red
            $script:ExitCode = 1
        } else {
            Write-Host "OK - historian authentication verified." -ForegroundColor Green
        }
    }

    if ($script:ExitCode -eq 0) {
        Write-Host ""
        if ($KeepData) {
            Write-Host "SUCCESS: code and images updated. History and settings kept." -ForegroundColor Green
            Write-Host "Note: INFLUX_RETENTION only applies when a historian is first created;"
            Write-Host "      changing it here does not alter the existing bucket."
        } else {
            Write-Host "SUCCESS: code, images, users, settings and history were restored." -ForegroundColor Green
        }
        $bind = [string]$script:RigEnv['FRONTEND_PORT']
        Write-Host "Open on this PC: http://localhost:$bind"
        $edgeIp = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
            Select-Object -ExpandProperty IPAddress -First 1
        if ($edgeIp) { Write-Host "Open from network PC: http://${edgeIp}:$bind" }
    }
}
finally {
    Pop-Location
}

exit $script:ExitCode
