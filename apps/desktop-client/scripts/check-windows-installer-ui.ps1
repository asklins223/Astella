param([Parameter(Mandatory=$true)][string]$Installer, [Parameter(Mandatory=$true)][string]$InstallDirectory,
  [Parameter(Mandatory=$true)][string]$Diagnostics)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing

function Find-Control($Window, [string]$Name) {
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Name)
  $found = $Window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  if (-not $found) { throw "界面缺少控件：$Name" }
  return $found
}
function Open-Window([string]$File, [string]$Arguments) {
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  do {
    $process.Refresh()
    if ($process.HasExited) { throw '安装窗口提前退出' }
    if ($process.MainWindowHandle -ne 0) { return @($process, [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)) }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw '没有出现原生安装窗口'
}
function Click($Control) { $Control.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Start-Sleep -Milliseconds 300 }
function Screenshot($Window, [string]$Name) {
  $bounds = $Window.Current.BoundingRectangle
  $bitmap = New-Object System.Drawing.Bitmap([int]$bounds.Width, [int]$bounds.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen([int]$bounds.X, [int]$bounds.Y, 0, 0, $bitmap.Size)
    $bitmap.Save((Join-Path $Diagnostics $Name), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}

$process = $null
try {
  $pair = Open-Window $Installer ('--install-dir "' + $InstallDirectory + '"')
  $process = $pair[0]; $window = $pair[1]
  $next = Find-Control $window '继续'
  if ($next.Current.IsEnabled) { throw '未勾选须知时继续按钮可用' }
  $consent = Find-Control $window '我已阅读并同意用户使用须知及非商用许可'
  $toggle = $consent.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
  if ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::Off) { throw '须知不应预先勾选' }
  Screenshot $window 'windows-installer-notice.png'
  Click (Find-Control $window '阅读许可全文 ↗')
  if ((Find-Control $window '继续').Current.IsEnabled) { throw '许可覆盖页上的继续按钮应禁用' }
  Click (Find-Control $window '返回须知')
  $toggle.Toggle(); Start-Sleep -Milliseconds 200
  Click (Find-Control $window '继续')
  $directory = Find-Control $window '安装文件夹'
  if ($directory.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -ne $InstallDirectory) { throw '向导没有沿用真实安装位置' }
  Screenshot $window 'windows-installer-location.png'
  Click (Find-Control $window '上一步')
  if ((Find-Control $window '我已阅读并同意用户使用须知及非商用许可').GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) { throw '返回时丢失已阅读状态' }
  $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
  $process.WaitForExit(10000) | Out-Null
  $helper = Join-Path $env:RUNNER_TEMP ('astella-ui-uninstall-' + [guid]::NewGuid().ToString('N') + '.exe')
  Copy-Item -LiteralPath (Join-Path $InstallDirectory 'Uninstall Astella.exe') -Destination $helper
  $pair = Open-Window $helper ('--uninstall --install-dir "' + $InstallDirectory + '"')
  $process = $pair[0]; $window = $pair[1]
  $delete = Find-Control $window '同时清除这台电脑的本机资料'
  if ($delete.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState -ne [System.Windows.Automation.ToggleState]::Off) { throw '卸载默认不应清除资料' }
  Screenshot $window 'windows-uninstaller-retention.png'
  $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
  $process.WaitForExit(10000) | Out-Null
  Write-Host 'Native installer consent, license, navigation and uninstall data defaults passed.'
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}
