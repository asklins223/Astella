param([Parameter(Mandatory=$true)][string]$Installer, [Parameter(Mandatory=$true)][string]$InstallDirectory,
  [Parameter(Mandatory=$true)][string]$Diagnostics)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing

function Find-Control($Window, [string]$Name, $Type) {
  # 可见文字也会进无障碍树：同名时（如「安装文件夹」的标签与输入框）必须按控件类型取，
  # 否则 FindFirst 会先命中标签 TextBlock，后面的 Value/Toggle 模式都拿不到。
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Name)
  foreach ($element in $Window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)) {
    if (-not $Type -or $element.Current.ControlType -eq $Type) { return $element }
  }
  throw "界面缺少控件：$Name"
}
function Assert-Visible($Control) {
  $bounds = $Control.Current.BoundingRectangle
  if ($Control.Current.IsOffscreen -or $bounds.Width -le 0 -or $bounds.Height -le 0) { throw "控件不可见：$($Control.Current.Name)" }
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
. (Join-Path $PSScriptRoot 'windows-rounded-sheet-probe.ps1')

$process = $null
try {
  $pair = Open-Window $Installer ('--install-dir "' + $InstallDirectory + '"')
  $process = $pair[0]; $window = $pair[1]
  $next = Find-Control $window '继续'
  if ($next.Current.IsEnabled) { throw '未勾选须知时继续按钮可用' }
  $consent = Find-Control $window '我已阅读并同意用户使用须知及非商用许可' ([System.Windows.Automation.ControlType]::CheckBox)
  $toggle = $consent.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
  if ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::Off) { throw '须知不应预先勾选' }
  Screenshot $window 'windows-installer-notice.png'
  # 无边框透明窗口的圆角与自绘标题按钮：与 check-windows-installer.ps1 对主窗口用同一条判据。
  Start-Sleep -Milliseconds 400
  Assert-RoundedSheet -Handle $process.MainWindowHandle -Window $window -Diagnostics $Diagnostics -CaptureName 'windows-installer-window.png' -Label '安装窗口'
  foreach ($caption in @('最小化', '关闭')) { Assert-Visible (Find-Control $window $caption ([System.Windows.Automation.ControlType]::Button)) }
  Write-Host '安装窗口四角透出背后层，自绘的标题按钮在无障碍树里。'
  Click (Find-Control $window '阅读许可全文 ↗')
  if ((Find-Control $window '继续').Current.IsEnabled) { throw '许可覆盖页上的继续按钮应禁用' }
  Assert-Visible (Find-Control $window '返回须知')
  Screenshot $window 'windows-installer-license.png'
  Click (Find-Control $window '返回须知')
  $toggle.Toggle(); Start-Sleep -Milliseconds 200
  Click (Find-Control $window '继续')
  $directory = Find-Control $window '安装文件夹' ([System.Windows.Automation.ControlType]::Edit)
  if ($directory.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -ne $InstallDirectory) { throw '向导没有沿用真实安装位置' }
  Assert-Visible (Find-Control $window '开始安装')
  $directory.SetFocus()
  if (-not $directory.Current.HasKeyboardFocus) { throw '安装文件夹无法取得键盘焦点' }
  Screenshot $window 'windows-installer-location.png'
  Click (Find-Control $window '上一步')
  if ((Find-Control $window '我已阅读并同意用户使用须知及非商用许可' ([System.Windows.Automation.ControlType]::CheckBox)).GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) { throw '返回时丢失已阅读状态' }
  $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
  $process.WaitForExit(10000) | Out-Null
  Write-Host 'Native consent, license, keyboard focus, navigation and the rounded sheet with self-drawn caption buttons passed.'
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}
