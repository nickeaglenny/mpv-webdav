# 把键盘焦点交给 mpv 的窗口（本应用用它让 mpv 拿到键盘焦点）
#
# 为什么要单独写个助手：
#   Windows 有"前台锁定"——后台进程直接激活别的窗口会被拒绝。真机对照实测：
#     · AllowSetForegroundWindow(mpvPid) → 返回 False（它要求**调用者自己**是前台进程，
#       而前台是用户的浏览器，不是我们，所以这条路在本项目里走不通）
#     · 单独 SetForegroundWindow / AppActivate → 无效（前台窗口不变，
#       而且 AppActivate 会"报告成功"却什么都没做，所以这里必须自己校验）
#     · 先模拟敲一下 ALT（系统会临时放宽前台锁定）再 SetForegroundWindow → 有效（实测）
#   本脚本就做最后这条，并且**激活后自己校验前台窗口**，没成功就退出码 1，
#   调用方会退回"让 mpv 自己最小化再还原"的办法。
#
# 用法:   powershell -NoProfile -ExecutionPolicy Bypass -File focus-mpv.ps1 <pid>
# 退出码: 0 = 已确认焦点在该进程窗口上；1 = 没成功
param(
    [Parameter(Mandatory = $true)][int]$ProcessId
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -Namespace MpvWebdav -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@

$proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if (-not $proc) { exit 1 }
$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { exit 1 }

# 窗口若被最小化，先还原（还原自己的窗口不违反前台锁定）
if ([MpvWebdav.Win]::IsIconic($hwnd)) { [MpvWebdav.Win]::ShowWindow($hwnd, 9) | Out-Null }

# 破限：模拟按一下 ALT（用户刚"按过"键的进程会被临时放宽前台锁定）
[MpvWebdav.Win]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)   # ALT down
[MpvWebdav.Win]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)   # ALT up
Start-Sleep -Milliseconds 90

for ($i = 0; $i -lt 3; $i++) {
    [MpvWebdav.Win]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 150
    if ([MpvWebdav.Win]::GetForegroundWindow() -eq $hwnd) { exit 0 }
}

exit 1
