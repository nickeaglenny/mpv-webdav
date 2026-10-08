# Generates the local test media used by tools/e2e-test.js (requires ffmpeg on PATH).
# Usage: pwsh -NoProfile -File tools/make-testdata.ps1 [-Ffmpeg <path>]

param(
    [string]$Ffmpeg = 'ffmpeg'
)

$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot 'testdata'
$movieDir = Join-Path $root '电影'
$animeDir = Join-Path $root '动画'
$subsDir = Join-Path $movieDir 'subs'
New-Item -ItemType Directory -Force -Path $movieDir, $animeDir, $subsDir | Out-Null

function New-Video([string]$out, [int]$seconds, [string]$pattern) {
    if (Test-Path $out) { Write-Host "skip  $out (已存在)"; return }
    Write-Host "gen   $out"
    & $Ffmpeg -hide_banner -loglevel error -y `
        -f lavfi -i "$pattern=size=320x240:rate=15" `
        -f lavfi -i 'sine=frequency=440:sample_rate=44100' `
        -t $seconds -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 96k -shortest `
        $out
}

New-Video (Join-Path $movieDir '测试影片.mkv') 12 'testsrc'
New-Video (Join-Path $animeDir '样片二.mp4') 8 'smptebars'
New-Video (Join-Path $root '单个短片.mp4') 5 'testsrc2'
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $root '单个短片.webm')

$chs = @"
1
00:00:00,200 --> 00:00:03,000
中文字幕：这是用 mpv 播放 WebDAV 视频的测试。

2
00:00:03,500 --> 00:00:07,000
如果这行字出现在画面上，说明外挂字幕已自动挂载。
"@
$eng = @"
1
00:00:00,200 --> 00:00:03,000
English subtitle: playing a WebDAV video with mpv.

2
00:00:03,500 --> 00:00:07,000
If you can read this, the external subtitle was loaded automatically.
"@
$zh = @"
[Script Info]
Title: 测试 ASS 字幕
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,28,&H00FFFFFF,&H000000FF,&H00000000,0,0,1,2,0,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.20,0:00:03.00,Default,,0,0,0,,ASS 字幕：来自 subs 子目录。
Dialogue: 0,0:00:03.50,0:00:07.00,Default,,0,0,0,,字幕搜索支持子目录（subs/subtitles/字幕）。
"@

Set-Content -Path (Join-Path $movieDir '测试影片.chs.srt') -Value $chs -Encoding UTF8
Set-Content -Path (Join-Path $movieDir '测试影片.eng.srt') -Value $eng -Encoding UTF8
Set-Content -Path (Join-Path $subsDir '测试影片.zh.ass') -Value $zh -Encoding UTF8
Set-Content -Path (Join-Path $animeDir '样片二.ass') -Value $zh -Encoding UTF8
Set-Content -Path (Join-Path $root '说明.txt') -Value "这是 mpv-webdav 的本地测试数据，用 tools/mock-webdav.js 提供 WebDAV 服务。" -Encoding UTF8

# ---- 编码测试目录：故意用 GBK(936) 保存字幕，用来验证服务端自动转 UTF-8 ----
$encDir = Join-Path $root '编码测试'
New-Item -ItemType Directory -Force -Path $encDir | Out-Null
$clip = Join-Path $root '单个短片.mp4'
$clipDst = Join-Path $encDir '胶片.mp4'
if ((Test-Path $clip) -and -not (Test-Path $clipDst)) { Copy-Item $clip $clipDst }

$gbkSrt = "1`r`n00:00:00,200 --> 00:00:03,000`r`n这句字幕是用 GBK 编码保存的：中文测试。`r`n`r`n2`r`n00:00:03,500 --> 00:00:05,000`r`n转成 UTF-8 之后 mpv 才能正确显示。`r`n"
$gbkAss = @"
[Script Info]
Title: GBK 编码的 ASS 字幕
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,28,&H00FFFFFF,&H000000FF,&H00000000,0,0,1,2,0,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.20,0:00:03.00,Default,,0,0,0,,这条 ASS 字幕同样是 GBK 编码。
"@

$gbk = [System.Text.Encoding]::GetEncoding(936)
[System.IO.File]::WriteAllText((Join-Path $encDir '胶片.chs.srt'), $gbkSrt, $gbk)
[System.IO.File]::WriteAllText((Join-Path $encDir '胶片.chs.ass'), $gbkAss, $gbk)
Write-Host '已写入 GBK 编码测试字幕: 编码测试\胶片.chs.srt / 胶片.chs.ass'

# ---- 剧集目录：一个目录里多个中文名视频（各 20 秒，便于验证中途停止时的续播记录）----
$seriesDir = Join-Path $root '剧集'
New-Item -ItemType Directory -Force -Path $seriesDir | Out-Null
foreach ($i in 1..3) {
    New-Video (Join-Path $seriesDir ('穹庐下的魔女 第{0:d2}集.mp4' -f $i)) 20 'testsrc2'
}
Write-Host '已准备剧集目录: 剧集\穹庐下的魔女 第01..03集.mp4（各 20 秒）'

Write-Host ''
Get-ChildItem -Recurse -File $root | ForEach-Object {
    '{0,10}  {1}' -f $_.Length, $_.FullName.Substring($root.Length + 1)
}
