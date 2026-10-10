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

  Write-Host 'Rounded transparent sheet and self-drawn caption buttons'
  # 圆角不是 CSS 写上去就算数：四个角必须透出窗口背后的那一层。取同屏窗口外的邻居像素与角上像素比对，
  # 直角不透明窗口会让两者不同（角上是应用自己的深色衬底），这条当场判红。
  Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes
  $handleDeadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $app.Refresh()
    if ($app.HasExited) { throw "已安装应用在看窗口句柄前退出：$($app.ExitCode)" }
    if ($app.MainWindowHandle -ne 0) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $handleDeadline)
  if ($app.MainWindowHandle -eq 0) { throw '已安装应用没有主窗口句柄' }
  $window = [System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
  $sheet = $window.Current.BoundingRectangle
  if ($sheet.Width -lt 300 -or $sheet.Height -lt 300) { throw "应用窗口尺寸异常：$sheet" }
  $originX = [int]$sheet.X - 8; $originY = [int]$sheet.Y - 8
  $shot = New-Object System.Drawing.Bitmap ([int]$sheet.Width + 16), ([int]$sheet.Height + 16)
  $canvas = [System.Drawing.Graphics]::FromImage($shot)
  try {
    $canvas.CopyFromScreen($originX, $originY, 0, 0, $shot.Size)
    $shot.Save((Join-Path $diagnostics 'windows-app-window.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    function Get-PixelAt([int]$x, [int]$y) { return $shot.GetPixel($x - $originX, $y - $originY) }
    function Same-Layer([int]$ax, [int]$ay, [int]$bx, [int]$by) {
      $a = Get-PixelAt $ax $ay; $b = Get-PixelAt $bx $by
      return ([Math]::Abs($a.R - $b.R) -lt 24) -and ([Math]::Abs($a.G - $b.G) -lt 24) -and ([Math]::Abs($a.B - $b.B) -lt 24)
    }
    $left = [int]$sheet.X; $top = [int]$sheet.Y
    $right = [int]($sheet.X + $sheet.Width) - 1; $bottom = [int]($sheet.Y + $sheet.Height) - 1
    $corners = @(
      @{ Name = '左上'; Corner = @(($left + 2), ($top + 2)); Outside = @(($left - 4), ($top - 4)); Inside = @(($left + 48), ($top + 48)) },
      @{ Name = '右上'; Corner = @(($right - 2), ($top + 2)); Outside = @(($right + 4), ($top - 4)); Inside = @(($right - 48), ($top + 48)) },
      @{ Name = '左下'; Corner = @(($left + 2), ($bottom - 2)); Outside = @(($left - 4), ($bottom + 4)); Inside = @(($left + 48), ($bottom - 48)) },
      @{ Name = '右下'; Corner = @(($right - 2), ($bottom - 2)); Outside = @(($right + 4), ($bottom + 4)); Inside = @(($right - 48), ($bottom - 48)) }
    )
    $checked = 0
    foreach ($corner in $corners) {
      $usable = $true
      foreach ($point in @($corner.Corner, $corner.Outside, $corner.Inside)) {
        if ($point[0] -lt $originX -or $point[1] -lt $originY -or ($point[0] - $originX) -ge $shot.Width -or ($point[1] - $originY) -ge $shot.Height) { $usable = $false }
      }
      # 贴到屏幕边缘时窗外没有可比像素，跳过这一角。
      if (-not $usable) { continue }
      if (-not (Same-Layer $corner.Corner[0] $corner.Corner[1] $corner.Outside[0] $corner.Outside[1])) {
        throw "$($corner.Name)角没有透出窗口背后那一层：圆角透明未生效（见 windows-app-window.png）"
      }
      if (Same-Layer $corner.Corner[0] $corner.Corner[1] $corner.Inside[0] $corner.Inside[1]) {
        throw "$($corner.Name)角与卡片内部同色：疑似窗口仍是直角"
      }
      $checked++
    }
    if ($checked -lt 2) { throw "可比对的窗口角只有 $checked 个，无法判断圆角是否生效" }
    Write-Host "四个角按可见性比对了 $checked 个，均透出背后层。"
    foreach ($name in @('最小化', '最大化', '关闭')) {
      $find = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $name)
      if (-not $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $find)) { throw "标题带缺少自绘按钮：$name" }
    }
    Write-Host '自绘标题按钮三个都在无障碍树里。'
  } finally {
    $canvas.Dispose(); $shot.Dispose()
  }
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
