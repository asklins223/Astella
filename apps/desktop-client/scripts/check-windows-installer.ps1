param([string]$Installer, [string]$ExpectedVersion)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw '此测试会安装和卸载应用，仅在全新的 GitHub Windows runner 中执行。' }
$packageRoot = Split-Path -Parent $PSScriptRoot
$diagnostics = Join-Path $packageRoot 'astella-diagnostics'
New-Item -ItemType Directory -Force $diagnostics | Out-Null
if (-not $Installer) {
  $Installer = (Get-ChildItem (Join-Path $packageRoot 'release') -Filter 'astella-*-win-x64.exe' | Select-Object -First 1).FullName
}
if (-not $Installer) { throw '缺少 Windows 安装包' }
$registryKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\c1f7918f-5d82-5edd-bbb5-ea9046add1bb'
if (Test-Path $registryKey) { throw '已有安装记录，此测试要求干净的 runner。' }
$profile = Join-Path $env:APPDATA 'astella-desktop-client'
if ((Test-Path $profile) -and (Get-ChildItem $profile -Force | Select-Object -First 1)) { throw '已有本机资料，此测试不会清除它。' }
$workspace = Join-Path $env:RUNNER_TEMP ('Astella 安装测试 ' + [guid]::NewGuid().ToString('N'))
$target = Join-Path $workspace 'my apps\拾星笔记'
$exe = Join-Path $target 'Astella.exe'
$marker = Join-Path $target 'astella-install.json'
$draft = Join-Path $profile 'installer-test-draft.txt'
New-Item -ItemType Directory -Force $profile, $workspace | Out-Null
Set-Content -LiteralPath $draft -Value 'unsynced draft' -Encoding utf8
$shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) '拾星笔记.lnk'
$startShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) '拾星笔记.lnk'

function Invoke-Installer([string]$File, [string[]]$Arguments) {
  # ProcessStartInfo.ArgumentList preserves Chinese, spaces, apostrophes and literal arguments.
  $start = [System.Diagnostics.ProcessStartInfo]::new($File)
  $start.UseShellExecute = $false
  $start.WorkingDirectory = $workspace
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  $p = [System.Diagnostics.Process]::Start($start)
  if (-not $p.WaitForExit(180000)) { Stop-Process -Id $p.Id -Force; throw '安装执行超时' }
  if ($p.ExitCode -ne 0) { throw "安装器退出码 $($p.ExitCode)" }
}
function Assert-Installed {
  if (-not (Test-Path $exe) -or -not (Test-Path $marker)) { throw '安装文件或标记缺失' }
  $record = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  if ($record.installDirectory -ne $target -or $record.version -ne $ExpectedVersion -or $record.licenseId -ne 'PolyForm-Noncommercial-1.0.0') { throw '安装位置、版本或许可登记不一致' }
  $registered = Get-ItemProperty $registryKey
  if ($registered.InstallLocation -ne $target -or $registered.DisplayVersion -ne $ExpectedVersion) { throw 'Windows 应用列表登记不一致' }
  foreach ($file in @($shortcut, $startShortcut, (Join-Path $target 'LICENSE.txt'), (Join-Path $target '用户使用须知.txt'), (Join-Path $target 'resources\app-update.yml'))) {
    if (-not (Test-Path $file)) { throw "安装缺少 $file" }
  }
}
function Assert-Uninstalled {
  foreach ($path in @($target, $registryKey, $shortcut, $startShortcut)) { if (Test-Path $path) { throw "卸载后残留 $path" } }
}
function Invoke-Uninstall([switch]$DeleteData) {
  # Run the same uninstaller outside its directory, and wait for its actual worker exit code.
  $helper = Join-Path $workspace 'uninstall-helper.exe'
  Copy-Item -LiteralPath (Join-Path $target 'Uninstall Astella.exe') -Destination $helper -Force
  $arguments = @('--uninstall', '--quiet', '--install-dir', $target)
  if ($DeleteData) { $arguments += '--delete-app-data' }
  Invoke-Installer $helper $arguments
  Assert-Uninstalled
}

try {
  Write-Host 'Install to a custom Chinese path'
  Invoke-Installer $Installer @('--quiet', '--install-dir', $target)
  Assert-Installed
  # Confirm native wizard consent, location, license and default-retention UI before mutations.
  # The UI script uses a UTF-8 BOM for Windows PowerShell's Chinese names and runs in STA.
  & powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'check-windows-installer-ui.ps1') -Installer $Installer -InstallDirectory $target -Diagnostics $diagnostics
  if ($LASTEXITCODE -ne 0) { throw 'Windows 安装界面交互检查未通过' }

  Write-Host 'Launch the installed Electron application'
  $start = [System.Diagnostics.ProcessStartInfo]::new($exe)
  $start.UseShellExecute = $false
  $start.WorkingDirectory = $target
  $start.ArgumentList.Add('--disable-gpu')
  $start.ArgumentList.Add('--force-renderer-accessibility')
  $start.ArgumentList.Add('--enable-logging=file')
  $start.ArgumentList.Add('--log-file=' + (Join-Path $diagnostics 'installed-chromium.log'))
  $app = [System.Diagnostics.Process]::Start($start)
  $trace = Join-Path $profile 'boot-trace.log'
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  do {
    if ($app.HasExited) { throw "已安装应用提前退出：$($app.ExitCode)" }
    $boot = if (Test-Path $trace) { Get-Content -LiteralPath $trace -Raw } else { '' }
    if ($boot -match 'preload-error|did-fail-load|render-process-gone') { throw "已安装应用启动失败：$boot" }
    if ($boot -match 'renderer-ready-to-show') { break }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($boot -notmatch 'renderer-ready-to-show') { throw '已安装应用没有确认渲染窗口就绪' }
  if (Test-Path $trace) { Copy-Item -LiteralPath $trace -Destination $diagnostics }

  Write-Host 'Self-drawn caption buttons (the main window rounded sheet is a real-machine check)'
  # 主窗口的逐像素圆角不在这里判：这一步用 --disable-gpu 起应用（runner 没有 GPU 才起得来），
  # 而 Chromium 在软件合成下不支持逐像素透明，CI 上永远拿不到「角上透出背后那一层」的证据。
  # 同一条判据留给真机探针 scripts/check-windows-window-rounding.ps1，在有你自己的 GPU 合成的机器上看。
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $handleDeadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $app.Refresh()
    if ($app.HasExited) { throw "已安装应用在看窗口句柄前退出：$($app.ExitCode)" }
    if ($app.MainWindowHandle -ne 0) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $handleDeadline)
  if ($app.MainWindowHandle -eq 0) { throw '已安装应用没有主窗口句柄' }
  $window = [System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
  foreach ($name in @('最小化', '最大化', '关闭')) {
    $find = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $name)
    if (-not $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $find)) { throw "标题带缺少自绘按钮：$name" }
  }
  Write-Host '自绘标题按钮三个都在无障碍树里。主窗口圆角透明需在真机跑 check-windows-window-rounding.ps1。'
  & taskkill.exe /PID $app.Id /T /F | Out-Null
  Start-Sleep -Seconds 3

  Write-Host 'Overwrite update: keep location and profile; remove stale program files'
  Set-Content -LiteralPath (Join-Path $target 'obsolete-file.txt') -Value 'old version'
  # Simulate an earlier installed version and verify the downloaded target version contract.
  $record = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  $record.version = '0.0.0'
  $record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $marker -Encoding utf8
  Invoke-Installer $Installer @('--update', '--quiet', '--install-dir', $target, '--target-version', $ExpectedVersion)
  Assert-Installed
  if (Test-Path (Join-Path $target 'obsolete-file.txt')) { throw '覆盖更新留下旧程序文件' }
  if ((Get-Content -LiteralPath $draft -Raw).Trim() -ne 'unsynced draft') { throw '更新损坏本机资料' }

  Write-Host 'Uninstall with default data retention'
  Invoke-Uninstall
  if (-not (Test-Path $draft)) { throw '默认卸载删除了草稿' }
  Write-Host 'Reinstall and explicitly clear local data'
  Invoke-Installer $Installer @('--quiet', '--install-dir', $target)
  Assert-Installed
  Invoke-Uninstall -DeleteData
  if (Test-Path $profile) { throw '选择清除后仍残留默认本机资料' }

  Write-Host 'Double-click path: a browser-downloaded copy launched through ShellExecute'
  # 上面每一步都带参数、走 ProcessStartInfo。真实用户是零参数、从资源管理器双击一份刚下载的、
  # 带网络来源标记的文件 —— 未签名包被拦下、或 .NET 启动器在 Main 之前失败，都只表现为没反应。
  $downloaded = Join-Path $workspace 'downloaded-like-setup.exe'
  Copy-Item -LiteralPath $Installer -Destination $downloaded -Force
  Set-Content -LiteralPath $downloaded -Stream Zone.Identifier -Encoding ascii -Value "`r`n[ZoneTransfer]`r`nZoneId=3`r`nReferrerUrl=https://github.com`r`n"
  $shell = Start-Process -FilePath $downloaded -PassThru -WorkingDirectory $workspace
  try {
    $shown = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ($true) {
      $shell.Refresh()
      if ($shell.MainWindowHandle -ne 0) { $shown = $true; break }
      if ($shell.HasExited) { throw "带网络来源标记的安装包双击后直接退出（退出码 $($shell.ExitCode)）" }
      if ([DateTime]::UtcNow -ge $deadline) { break }
      Start-Sleep -Milliseconds 250
    }
    if (-not $shown) { throw '带网络来源标记的安装包双击后 60 秒内没有出界面' }
    # 心跳由 Program.Main 第一行落盘：用户在别的机器上遇到没反应时，这是唯一能分层判断的依据。
    $heartbeat = Join-Path $env:LOCALAPPDATA 'Astella\setup-logs\startup.log'
    if (-not (Test-Path $heartbeat)) { throw '安装器没有留下启动心跳，故障无法分层判断' }
    Write-Host "心跳已落盘：$((Get-Item -LiteralPath $heartbeat).Length) 字节"
  } finally {
    if (-not $shell.HasExited) { Stop-Process -Id $shell.Id -Force }
    Remove-Item -LiteralPath $downloaded -Force
  }
  Write-Host 'Install, native UI, launch, overwrite update, retain-data uninstall and clear-data uninstall passed.'
} finally {
  $logs = Join-Path $env:LOCALAPPDATA 'Astella\setup-logs'
  if (Test-Path $logs) { Copy-Item -LiteralPath $logs -Destination $diagnostics -Recurse -Force }
  if (Test-Path $profile) { Copy-Item -LiteralPath $profile -Destination (Join-Path $diagnostics 'profile') -Recurse -Force }
}
