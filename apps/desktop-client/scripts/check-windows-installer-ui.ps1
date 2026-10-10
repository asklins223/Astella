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
function Wait-Control($Window, [string]$Name, $Process) {
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  do {
    $Process.Refresh()
    if ($Process.HasExited) { throw "等待 $Name 时窗口提前退出" }
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Name)
    $found = $Window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($found -and -not $found.Current.IsOffscreen -and $found.Current.BoundingRectangle.Width -gt 0) { return $found }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "界面没有到达：$Name"
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
function Test-SameLayer($Shot, [int]$OriginX, [int]$OriginY, $A, $B) {
  $first = $Shot.GetPixel($A[0] - $OriginX, $A[1] - $OriginY)
  $second = $Shot.GetPixel($B[0] - $OriginX, $B[1] - $OriginY)
  return ([Math]::Abs($first.R - $second.R) -lt 24) -and ([Math]::Abs($first.G - $second.G) -lt 24) -and ([Math]::Abs($first.B - $second.B) -lt 24)
}
function Assert-RoundedSheet($Window, [string]$Diagnostics) {
  # 圆角不是写了 CornerRadius 就算数：四角必须透出窗口背后的那一层。判据与 check-windows-installer.ps1
  # 对主窗口的相同 —— 取同屏窗口外的邻居像素与角上像素比对，直角不透明窗口会让两者不同。
  $sheet = $Window.Current.BoundingRectangle
  if ($sheet.Width -lt 300 -or $sheet.Height -lt 300) { throw "安装窗口尺寸异常：$sheet" }
  $originX = [int]$sheet.X - 8; $originY = [int]$sheet.Y - 8
  $shot = New-Object System.Drawing.Bitmap ([int]$sheet.Width + 16), ([int]$sheet.Height + 16)
  $canvas = [System.Drawing.Graphics]::FromImage($shot)
  try {
    $canvas.CopyFromScreen($originX, $originY, 0, 0, $shot.Size)
    $shot.Save((Join-Path $Diagnostics 'windows-installer-window.png'), [System.Drawing.Imaging.ImageFormat]::Png)
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
      if (-not $usable) { continue }
      if (-not (Test-SameLayer $shot $originX $originY $corner.Corner $corner.Outside)) {
        throw "$($corner.Name)角没有透出窗口背后那一层：安装窗口仍是直角不透明（见 windows-installer-window.png）"
      }
      if (Test-SameLayer $shot $originX $originY $corner.Corner $corner.Inside) {
        throw "$($corner.Name)角与纸面同色：疑似窗口仍是直角"
      }
      $checked++
    }
    if ($checked -lt 2) { throw "可比对的窗口角只有 $checked 个，无法判断圆角是否生效" }
    Write-Host "安装窗口四个角按可见性比对了 $checked 个，均透出背后层。"
  } finally { $canvas.Dispose(); $shot.Dispose() }
}

$process = $null
$waiter = $null
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
  Assert-RoundedSheet $window $Diagnostics
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
  # 真正运行同版更新；短暂等待独立进程，保证能检查可操作的进度窗口。
  # 释放等待后由安装器完成，不强杀安装器，避免留下半份暂存目录。
  $waiter = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -Command "Start-Sleep -Seconds 90"' -PassThru -WindowStyle Hidden
  $pair = Open-Window $Installer ('--update --wait-pid ' + $waiter.Id + ' --install-dir "' + $InstallDirectory + '"')
  $process = $pair[0]; $window = $pair[1]
  $progress = Wait-Control $window '更新进度' $process
  $null = Wait-Control $window '正在为书房更新' $process
  if ((Find-Control $window '请稍候').Current.IsEnabled) { throw '更新执行期间主按钮不应可用' }
  if ((Find-Control $window '关闭').Current.IsEnabled) { throw '更新执行期间关闭按钮不应可用' }
  Assert-Visible $progress
  Screenshot $window 'windows-installer-update-progress.png'
  Stop-Process -Id $waiter.Id -Force
  $waiter = $null
  $null = Wait-Control $window '书房更新好了' $process
  Assert-Visible (Find-Control $window '打开书房')
  Screenshot $window 'windows-installer-update-done.png'
  $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
  $process.WaitForExit(10000) | Out-Null
  $helper = Join-Path $env:RUNNER_TEMP ('astella-ui-uninstall-' + [guid]::NewGuid().ToString('N') + '.exe')
  Copy-Item -LiteralPath (Join-Path $InstallDirectory 'Uninstall Astella.exe') -Destination $helper
  $pair = Open-Window $helper ('--uninstall --install-dir "' + $InstallDirectory + '"')
  $process = $pair[0]; $window = $pair[1]
  $delete = Find-Control $window '同时清除这台电脑的本机资料' ([System.Windows.Automation.ControlType]::CheckBox)
  if ($delete.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState -ne [System.Windows.Automation.ToggleState]::Off) { throw '卸载默认不应清除资料' }
  Assert-Visible (Find-Control $window '卸载应用' ([System.Windows.Automation.ControlType]::Button))
  Screenshot $window 'windows-uninstaller-retention.png'
  $delete.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
  Start-Sleep -Milliseconds 200
  Assert-Visible (Find-Control $window '卸载并清除资料')
  Assert-Visible (Find-Control $window '应用与本机资料，一起清除')
  Screenshot $window 'windows-uninstaller-clear-data.png'
  $delete.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
  Start-Sleep -Milliseconds 200
  Assert-Visible (Find-Control $window '卸载应用' ([System.Windows.Automation.ControlType]::Button))
  $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
  $process.WaitForExit(10000) | Out-Null
  Write-Host 'Native consent, license, keyboard focus, navigation, rounded sheet, visible update progress/completion and reversible uninstall data choice passed.'
} finally {
  if ($waiter -and -not $waiter.HasExited) { Stop-Process -Id $waiter.Id -Force }
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}
