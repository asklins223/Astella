param([string]$Executable, [string]$Diagnostics)
$ErrorActionPreference = 'Stop'
# 真机探针：主窗口的逐像素圆角只能在有 GPU 合成的 Windows 机器上看。
#
# CI 那一步（check-windows-installer.ps1）用 --disable-gpu 起应用——runner 没有别的办法起来——
# 而 Chromium 在软件合成下不支持逐像素透明，所以「角上透出背后那一层」在 CI 上永远拿不到证据。
# 同一条判据（windows-rounded-sheet-probe.ps1）在 CI 上仍然闸住安装窗口，因为 WPF 的分层透明
# 窗口不依赖 GPU 合成。主窗口这一项就留给你自己的机器。
#
# 用法（应用已安装）：
#   powershell -STA -NoProfile -ExecutionPolicy Bypass -File apps\desktop-client\scripts\check-windows-window-rounding.ps1
#   可选 -Executable '<安装目录>\Astella.exe'，可选 -Diagnostics '<输出目录>'
# 应用有单实例锁：你已经开着窗口时，探针直接用那个窗口，不会再起一个。

$packageRoot = Split-Path -Parent $PSScriptRoot
if (-not $Diagnostics) { $Diagnostics = Join-Path $packageRoot 'astella-diagnostics' }
New-Item -ItemType Directory -Force $Diagnostics | Out-Null

if (-not $Executable) {
  # 安装位置取安装器写下的卸载记录。
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\c1f7918f-5d82-5edd-bbb5-ea9046add1bb'
  if (Test-Path -LiteralPath $key) {
    $installed = (Get-ItemProperty -LiteralPath $key).InstallLocation
    if ($installed) { $Executable = Join-Path $installed 'Astella.exe' }
  }
}
if (-not $Executable) { throw '没找到已安装的 Astella.exe：用 -Executable 指定安装目录里的可执行文件。' }
if (-not (Test-Path -LiteralPath $Executable)) { throw "可执行文件不存在：$Executable" }

. (Join-Path $PSScriptRoot 'windows-rounded-sheet-probe.ps1')
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

# 先看是不是已经开着（单实例锁会让第二个进程直接退出，拿不到窗口）。
$app = Get-Process -Name 'Astella' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$launched = $false
if (-not $app) {
  $app = Start-Process -FilePath $Executable -WorkingDirectory (Split-Path -Parent $Executable) -PassThru
  $launched = $true
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  do {
    $app.Refresh()
    if ($app.HasExited) { throw "应用在看窗口句柄前退出：$($app.ExitCode)" }
    Start-Sleep -Milliseconds 250
  } while ($app.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline)
}
if ($app.MainWindowHandle -eq 0) { throw '没有出现主窗口，无法比对圆角。' }

$window = [System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
try {
  # 等渲染层挂上圆角：自绘标题按钮进无障碍树，说明无边框那套已经生效。
  $find = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, '最小化')
  $ready = [DateTime]::UtcNow.AddSeconds(30)
  while (-not $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $find) -and [DateTime]::UtcNow -lt $ready) { Start-Sleep -Milliseconds 300 }
  Assert-RoundedSheet -Handle $app.MainWindowHandle -Window $window -Diagnostics $Diagnostics -CaptureName 'windows-app-window.png' -Label '主窗口'
  Write-Host "两张图留在 $Diagnostics\windows-app-window.png 与 windows-app-window-behind.png。"
} finally {
  # 探针自己起的实例用完关掉；你原本开着的那个不动。
  if ($launched -and -not $app.HasExited) {
    $app.CloseMainWindow() | Out-Null
    Start-Sleep -Milliseconds 800
    if (-not $app.HasExited) { Stop-Process -Id $app.Id -Force }
  }
}
