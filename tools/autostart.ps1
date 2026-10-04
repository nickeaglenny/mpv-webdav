<#
.SYNOPSIS
    管理 mpv-webdav 的开机自启：在当前用户的「启动」文件夹里放一个快捷方式，
    登录后自动以托盘方式常驻（不弹黑窗）。

.EXAMPLE
    pwsh -NoProfile -File .\tools\autostart.ps1 -Status      # 查看是否已设置
    pwsh -NoProfile -File .\tools\autostart.ps1 -Install     # 设置开机自启
    pwsh -NoProfile -File .\tools\autostart.ps1 -Uninstall   # 取消开机自启
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$Status,
    [string]$LnkPath   # 仅供测试：把快捷方式写到别的位置
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root 'start-tray.vbs'
$startupDir = [Environment]::GetFolderPath('Startup')
$lnkPath = if ($LnkPath) { $LnkPath } else { Join-Path $startupDir 'mpv-webdav.lnk' }

function Show-Status {
    Write-Host "启动文件夹 : $startupDir"
    Write-Host "快捷方式   : $lnkPath"
    if (Test-Path $lnkPath) {
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut($lnkPath)
        Write-Host "状态       : 已设置开机自启 ✅" -ForegroundColor Green
        Write-Host "目标       : $($lnk.TargetPath) $($lnk.Arguments)"
    } else {
        Write-Host "状态       : 未设置（登录后需要手动双击 start-tray.vbs）" -ForegroundColor Yellow
    }
    Write-Host "启动脚本   : $launcher  $(if (Test-Path $launcher) { '（存在）' } else { '（缺失！）' })"
}

function Install-Shortcut {
    if (-not (Test-Path $launcher)) { throw "找不到启动脚本：$launcher" }
    $dir = Split-Path -Parent $lnkPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $lnk.Arguments = '"{0}"' -f $launcher
    $lnk.WorkingDirectory = $root
    $lnk.WindowStyle = 7          # 最小化：配合 VBS 完全无窗口
    $lnk.Description = 'mpv-webdav 托盘常驻（开机自启）'
    $lnk.Save()
    Write-Host "已设置开机自启 ✅" -ForegroundColor Green
    Write-Host "  快捷方式: $lnkPath"
    Write-Host "  指向    : wscript.exe `"$launcher`""
    Write-Host "  下次登录会自动在托盘常驻；也可以现在就双击 start-tray.vbs 试一下。"
}

function Uninstall-Shortcut {
    if (Test-Path $lnkPath) {
        Remove-Item $lnkPath -Force
        Write-Host "已取消开机自启 ✅（只删了这一个快捷方式，其它文件没动）" -ForegroundColor Green
    } else {
        Write-Host "本来就没有设置开机自启。" -ForegroundColor Yellow
    }
}

if ($Install) { Install-Shortcut }
elseif ($Uninstall) { Uninstall-Shortcut }
else { Show-Status }
