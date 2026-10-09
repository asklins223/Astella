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
  Write-Host 'Install, native UI, launch, overwrite update, retain-data uninstall and clear-data uninstall passed.'
} finally {
  $logs = Join-Path $env:LOCALAPPDATA 'Astella\setup-logs'
  if (Test-Path $logs) { Copy-Item -LiteralPath $logs -Destination $diagnostics -Recurse -Force }
  if (Test-Path $profile) { Copy-Item -LiteralPath $profile -Destination (Join-Path $diagnostics 'profile') -Recurse -Force }
}
