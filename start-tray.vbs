' 无窗口启动 mpv-webdav 托盘（双击本文件即可，不会出现黑色命令行窗口）
Option Explicit

Dim sh, fso, root, ps, cmd, rc
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root

If Not fso.FileExists(root & "\tray.ps1") Then
    MsgBox "找不到 tray.ps1，请确认本文件与 tray.ps1 在同一个目录：" & vbCrLf & root, 16, "mpv-webdav"
    WScript.Quit 1
End If

' 优先用 PowerShell 7（pwsh），没有就退回系统自带的 powershell.exe
rc = sh.Run("cmd /c where pwsh >nul 2>nul", 0, True)
If rc = 0 Then
    ps = "pwsh"
Else
    ps = "powershell.exe"
End If

cmd = ps & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\tray.ps1"""
sh.Run cmd, 0, False
