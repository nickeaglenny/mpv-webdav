<#
.SYNOPSIS
    mpv-webdav 托盘常驻：在后台启动服务，右下角托盘图标提供
    打开控制台 / 重启服务 / 打开数据目录 / 查看日志 / 开机自启 / 退出。

.EXAMPLE
    pwsh -NoProfile -File .\tray.ps1              # 常驻托盘（推荐用 start-tray.vbs，无黑窗）
    pwsh -NoProfile -File .\tray.ps1 -OpenBrowser # 启动后顺便打开控制台
    pwsh -NoProfile -File .\tray.ps1 -SelfTest    # 只做启动+自检+退出，不显示托盘
#>
[CmdletBinding()]
param(
    [int]$Port = 8787,
    [switch]$OpenBrowser,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

$script:Root = $PSScriptRoot
$script:Url = "http://127.0.0.1:$Port/"
$script:LogDir = Join-Path $script:Root 'logs'
$script:OutLog = Join-Path $script:LogDir 'server.log'
$script:ErrLog = Join-Path $script:LogDir 'server.err.log'
$script:ServerScript = Join-Path $script:Root 'server\index.js'
$script:StartupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'mpv-webdav.lnk'
$script:Launcher = Join-Path $script:Root 'start-tray.vbs'
$script:serverProc = $null
$script:startedByUs = $false
$script:lastError = ''

function Test-Health {
    try {
        $r = Invoke-RestMethod -Uri "$($script:Url)api/health" -TimeoutSec 2 -ErrorAction Stop
        return [bool]$r.ok
    } catch { return $false }
}

function Get-Token {
    try { return (Invoke-RestMethod -Uri "$($script:Url)api/state" -TimeoutSec 3).streamToken } catch { return $null }
}

function Start-Server {
    if (Test-Health) { $script:startedByUs = $false; return 'reused' }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { $script:lastError = '未找到 Node.js，请先安装 Node.js 18+'; return 'nonode' }

    New-Item -ItemType Directory -Force -Path $script:LogDir | Out-Null
    $env:MPV_WEBDAV_PORT = [string]$Port
    Remove-Item Env:MPV_WEBDAV_OPEN -ErrorAction SilentlyContinue

    $script:serverProc = Start-Process -FilePath $node.Source `
        -ArgumentList ('"{0}"' -f $script:ServerScript) `
        -WorkingDirectory $script:Root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $script:OutLog -RedirectStandardError $script:ErrLog
    $script:startedByUs = $true

    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 250
        if (Test-Health) { return 'started' }
        if ($script:serverProc.HasExited) {
            $script:lastError = (Get-Content $script:ErrLog -Raw -ErrorAction SilentlyContinue)
            if (-not $script:lastError) { $script:lastError = '服务进程异常退出（见 logs\server.err.log）' }
            return 'failed'
        }
    }
    $script:lastError = '启动超时（30 秒内没有响应 /api/health）'
    return 'timeout'
}

function Stop-Server {
    if (-not $script:startedByUs) { return }   # 复用别人的实例时不要去关它
    $token = Get-Token
    if ($token) {
        try {
            Invoke-RestMethod -Uri "$($script:Url)api/shutdown" -Method Post -ContentType 'application/json' `
                -Body (@{ token = $token } | ConvertTo-Json) -TimeoutSec 5 | Out-Null
        } catch { /* 接口不可用就强制结束 */ }
    }
    for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep -Milliseconds 250
        if (-not (Test-Health)) { return }
    }
    if ($script:serverProc -and -not $script:serverProc.HasExited) {
        Stop-Process -Id $script:serverProc.Id -Force -ErrorAction SilentlyContinue
    }
}

function Restart-Server {
    $token = Get-Token
    if ($token) {
        try {
            Invoke-RestMethod -Uri "$($script:Url)api/shutdown" -Method Post -ContentType 'application/json' `
                -Body (@{ token = $token } | ConvertTo-Json) -TimeoutSec 5 | Out-Null
        } catch { /* ignore */ }
    }
    for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep -Milliseconds 250
        if (-not (Test-Health)) { break }
    }
    $script:startedByUs = $false
    return (Start-Server)
}

function Open-Console { Start-Process $script:Url }

function Get-AutostartEnabled { return (Test-Path $script:StartupLnk) }

function Set-Autostart([bool]$enabled) {
    if ($enabled) {
        if (-not (Test-Path $script:Launcher)) { throw "找不到 $($script:Launcher)" }
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut($script:StartupLnk)
        $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
        $lnk.Arguments = '"{0}"' -f $script:Launcher
        $lnk.WorkingDirectory = $script:Root
        $lnk.WindowStyle = 7
        $lnk.Description = 'mpv-webdav 托盘常驻（开机自启）'
        $lnk.Save()
    } else {
        Remove-Item $script:StartupLnk -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------- 自检模式 ---
if ($SelfTest) {
    $result = Start-Server
    Write-Host "启动结果 : $result"
    if (Test-Health) {
        $state = Invoke-RestMethod -Uri "$($script:Url)api/state" -TimeoutSec 5
        Write-Host "健康检查 : OK   $($script:Url)"
        Write-Host "专辑     : $($state.albums.Count) 个$(if ($state.albums.Count) { '（' + (($state.albums | ForEach-Object { $_.name }) -join '、') + '）' })"
        Write-Host "mpv      : $($state.mpv.path)  检测到=$($state.mpv.found)"
        Write-Host "日志     : $($script:OutLog)"
    } else {
        Write-Host "健康检查 : 失败"
        if ($script:lastError) { Write-Host $script:lastError }
    }
    Stop-Server
    Start-Sleep -Milliseconds 300
    Write-Host "已停止   : $(-not (Test-Health))"
    exit 0
}

# ------------------------------------------------------------- 单实例保护 ---
$mutex = New-Object System.Threading.Mutex($false, 'Local\mpv-webdav-tray')
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch { $owned = $false }
if (-not $owned) {
    Write-Host '托盘已经在运行了。'
    Open-Console
    exit 0
}

# ------------------------------------------------------------------ 主流程 ---
$result = Start-Server
switch ($result) {
    'nonode' { Write-Host $script:lastError -ForegroundColor Red; exit 1 }
    'failed' { Write-Host "启动失败：$($script:lastError)" -ForegroundColor Red; exit 1 }
    'timeout' { Write-Host $script:lastError -ForegroundColor Red; exit 1 }
}

if ($OpenBrowser) { Open-Console }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:ni = New-Object System.Windows.Forms.NotifyIcon
$script:ni.Icon = [System.Drawing.SystemIcons]::Application
$script:ni.Text = "mpv-webdav（端口 $Port）"
$script:ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miOpen = $menu.Items.Add('打开控制台')
$miOpen.add_Click({ Open-Console })

$miRestart = $menu.Items.Add('重启服务')
$miRestart.add_Click({
    $script:ni.Text = 'mpv-webdav（重启中…）'
    $r = Restart-Server
    $script:ni.Text = "mpv-webdav（端口 $Port）"
    if ($r -eq 'started' -or $r -eq 'reused') {
        $script:ni.ShowBalloonTip(2500, 'mpv-webdav', '服务已重启', [System.Windows.Forms.ToolTipIcon]::Info)
    } else {
        $script:ni.ShowBalloonTip(4000, 'mpv-webdav 重启失败', [string]$script:lastError, [System.Windows.Forms.ToolTipIcon]::Error)
    }
})

[void]$menu.Items.Add('-')

$miData = $menu.Items.Add('打开数据目录')
$miData.add_Click({ $dir = Join-Path $script:Root 'data'; if (Test-Path $dir) { Start-Process $dir } else { [void][System.Windows.Forms.MessageBox]::Show('还没有数据目录：' + $dir) } })

$miLog = $menu.Items.Add('查看日志')
$miLog.add_Click({
    if (Test-Path $script:OutLog) { Start-Process notepad.exe $script:OutLog }
    else { [void][System.Windows.Forms.MessageBox]::Show('还没有日志文件：' + $script:OutLog) }
})

[void]$menu.Items.Add('-')

$miAuto = $menu.Items.Add('开机自启')
$miAuto.CheckOnClick = $true
$miAuto.Checked = Get-AutostartEnabled
$miAuto.add_Click({
    try {
        Set-Autostart $miAuto.Checked
        $msg = if ($miAuto.Checked) { '已设置开机自启' } else { '已取消开机自启' }
        $script:ni.ShowBalloonTip(2500, 'mpv-webdav', $msg, [System.Windows.Forms.ToolTipIcon]::Info)
    } catch {
        $miAuto.Checked = Get-AutostartEnabled
        [void][System.Windows.Forms.MessageBox]::Show('设置失败：' + $_.Exception.Message)
    }
})

[void]$menu.Items.Add('-')

$miQuit = $menu.Items.Add('退出')
$miQuit.add_Click({
    $script:ni.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

$script:ni.ContextMenuStrip = $menu
$script:ni.add_DoubleClick({ Open-Console })
$script:ni.ShowBalloonTip(3500, 'mpv-webdav 已就绪', "双击托盘图标打开控制台：$($script:Url)", [System.Windows.Forms.ToolTipIcon]::Info)

[System.Windows.Forms.Application]::Run()

$script:ni.Visible = $false
$script:ni.Dispose()
Stop-Server
$mutex.ReleaseMutex()
