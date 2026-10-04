<#
.SYNOPSIS
    启动 mpv-webdav 本地服务。

.EXAMPLE
    pwsh -NoProfile -File .\start.ps1
    pwsh -NoProfile -File .\start.ps1 -Port 9000
    pwsh -NoProfile -File .\start.ps1 -NoBrowser
#>
param(
    [int]$Port = 8787,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '[错误] 未找到 Node.js，请先安装 Node.js 18 或更高版本: https://nodejs.org/' -ForegroundColor Red
    exit 1
}

$env:MPV_WEBDAV_PORT = [string]$Port
$extra = @()
if (-not $NoBrowser) { $extra += '--open' }

Write-Host "正在启动 mpv-webdav（端口 $Port）..." -ForegroundColor Cyan
Write-Host "控制台地址: http://127.0.0.1:$Port/" -ForegroundColor Cyan
Write-Host '按 Ctrl+C 退出'
& node (Join-Path $PSScriptRoot 'server\index.js') @extra
