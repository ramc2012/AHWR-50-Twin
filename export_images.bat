@echo off
setlocal
cd /d "%~dp0"
echo =======================================================
echo    Exporting Docker images for offline transfer...
echo =======================================================

echo Building current application images...
docker compose -p ahwr-50-twin build backend frontend mcp-edge
if errorlevel 1 (
    echo [ERROR] Image build failed. Nothing was exported.
    pause
    exit /b 1
)

mkdir images 2>nul
echo Exporting Backend...
docker save ahwr-50-twin-backend -o images\backend.tar
echo Exporting Frontend...
docker save ahwr-50-twin-frontend -o images\frontend.tar
REM mcp-edge is in the DEFAULT compose profile and has a build: context, so without
REM this tar an air-gapped PC tries to build it from source and the stack fails.
echo Exporting Edge MCP server...
docker save ahwr-50-twin-mcp-edge -o images\mcp-edge.tar
echo Exporting InfluxDB...
docker save influxdb:2.7 -o images\influxdb.tar
echo Exporting Telegraf...
docker save telegraf:1.29 -o images\telegraf.tar
echo.
echo Done! You can now copy this entire folder to your pendrive.
echo Remember to copy certs\mcp.crt and certs\mcp.key too - mcp-edge needs them.
pause
