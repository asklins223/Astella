# 圆角透明的唯一判据：同一个屏幕位置，窗口在的时候与窗口藏起来的时候必须透出同一层。
#
# 原先拿「窗外邻居像素」当背后层参考，在真实桌面上不成立：任务栏上有图标和文字、壁纸有图案，
# 两个相邻像素本来就可以差很远。2026-10-10 在 CI 的 Windows runner 上，安装窗口贴着桌面图标，
# 右下角明明已经透出背后那一层，却因为参考点落在图标的文字上被判成直角。
# 现在把窗口藏起来重拍同一块区域，参考就是它自己背后那一层，与桌面上是什么图案无关。
#
# 屏幕边界只取 UIA 根元素：它与窗口 BoundingRectangle 同一坐标系。WinForms 的 WorkArea 在这台
# runner 上取不到值（第四轮实测：$area 为空，Min(920,0) 把窗口缩成 0，被 XAML 的 MinWidth/MinHeight
# 顶成 760×520，再判「摆不进」）。主窗口最小 1280×720 比 runner 屏幕还宽，屏外的角没法看像素，
# 因此点名跳过、至少比对到两个角才给过。

Add-Type -AssemblyName System.Drawing, UIAutomationClient

if (-not ('Astella.Probe.Win32' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Astella.Probe {
  public static class Win32 {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int Width, int Height, bool Repaint);
  }
}
'@
}

function Get-ScreenShot([int]$X, [int]$Y, [int]$Width, [int]$Height) {
  $bitmap = New-Object System.Drawing.Bitmap $Width, $Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.CopyFromScreen($X, $Y, 0, 0, $bitmap.Size) } finally { $graphics.Dispose() }
  return $bitmap
}

function Test-SamePixel($WithWindow, $Behind, [int]$X, [int]$Y, [int]$OriginX, [int]$OriginY) {
  $a = $WithWindow.GetPixel($X - $OriginX, $Y - $OriginY)
  $b = $Behind.GetPixel($X - $OriginX, $Y - $OriginY)
  return ([Math]::Abs($a.R - $b.R) -lt 24) -and ([Math]::Abs($a.G - $b.G) -lt 24) -and ([Math]::Abs($a.B - $b.B) -lt 24)
}

function Assert-RoundedSheet {
  param(
    [System.IntPtr]$Handle,
    $Window,
    [string]$Diagnostics,
    [string]$CaptureName,
    [string]$Label
  )
  $sheet = $Window.Current.BoundingRectangle
  if ($sheet.Width -lt 300 -or $sheet.Height -lt 300) { throw "$Label 窗口尺寸异常：$sheet" }
  $screen = [System.Windows.Automation.AutomationElement]::RootElement.Current.BoundingRectangle
  if ($screen.Width -lt 300 -or $screen.Height -lt 300) { throw "$Label 读不到有效屏幕边界：$screen" }
  # 窗口整体超出屏幕时先摆回屏内（窗口自己比屏幕大就摆不下，留给下面的点名跳过）。
  $outside = ($sheet.X -lt $screen.X -or $sheet.Y -lt $screen.Y -or ($sheet.X + $sheet.Width) -gt ($screen.X + $screen.Width) -or ($sheet.Y + $sheet.Height) -gt ($screen.Y + $screen.Height))
  if ($outside) {
    $fitWidth = [Math]::Min([int]$sheet.Width, [int]$screen.Width)
    $fitHeight = [Math]::Min([int]$sheet.Height, [int]$screen.Height)
    [Astella.Probe.Win32]::MoveWindow($Handle, [int]$screen.X, [int]$screen.Y, $fitWidth, $fitHeight, $true) | Out-Null
    Start-Sleep -Milliseconds 600
    $moved = $Window.Current.BoundingRectangle
    Write-Host "$Label 原本超出屏幕（$sheet），已按屏幕 $screen 摆到 $moved。"
    $sheet = $moved
  }
  # 只拍落在屏幕里的那一块（CopyFromScreen 拿到屏外坐标会直接失败），外加 8px 环带：
  # 环带在窗口之外，两张图里必须一模一样——藏窗那一下若被别的窗口抢到前面，这里就能看出来。
  $grownX = [int]$sheet.X - 8; $grownY = [int]$sheet.Y - 8
  $grownRight = [int]($sheet.X + $sheet.Width) + 8; $grownBottom = [int]($sheet.Y + $sheet.Height) + 8
  $originX = [Math]::Max($grownX, [int]$screen.X)
  $originY = [Math]::Max($grownY, [int]$screen.Y)
  $extentX = [Math]::Min($grownRight, [int]($screen.X + $screen.Width))
  $extentY = [Math]::Min($grownBottom, [int]($screen.Y + $screen.Height))
  $width = $extentX - $originX; $height = $extentY - $originY
  if ($width -lt 120 -or $height -lt 120) { throw "$Label 在屏幕里只剩 $width×$height，无法比对任何一角：窗口 $sheet / 屏幕 $screen" }

  $withWindow = Get-ScreenShot $originX $originY $width $height
  try {
    [Astella.Probe.Win32]::ShowWindow($Handle, 0) | Out-Null # SW_HIDE
    Start-Sleep -Milliseconds 500
    $behind = Get-ScreenShot $originX $originY $width $height
    try {
      [Astella.Probe.Win32]::ShowWindow($Handle, 5) | Out-Null # SW_SHOW
      Start-Sleep -Milliseconds 500
      if (-not [Astella.Probe.Win32]::IsWindowVisible($Handle)) { throw "$Label 藏起来之后没有重新显示" }
      $restored = $Window.Current.BoundingRectangle
      if ([int]$restored.X -ne [int]$sheet.X -or [int]$restored.Y -ne [int]$sheet.Y) { throw "$Label 重新显示后位置变了：$sheet → $restored" }
      $behindName = $CaptureName -replace '\.png$', '-behind.png'
      $withWindow.Save((Join-Path $Diagnostics $CaptureName), [System.Drawing.Imaging.ImageFormat]::Png)
      $behind.Save((Join-Path $Diagnostics $behindName), [System.Drawing.Imaging.ImageFormat]::Png)
      $left = [int]$sheet.X; $top = [int]$sheet.Y
      $right = [int]($sheet.X + $sheet.Width) - 1; $bottom = [int]($sheet.Y + $sheet.Height) - 1
      $corners = @(
        @{ Name = '左上'; Corner = @(($left + 2), ($top + 2)); Ring = @(($left - 4), ($top - 4)); Inside = @(($left + 48), ($top + 48)) },
        @{ Name = '右上'; Corner = @(($right - 2), ($top + 2)); Ring = @(($right + 4), ($top - 4)); Inside = @(($right - 48), ($top + 48)) },
        @{ Name = '左下'; Corner = @(($left + 2), ($bottom - 2)); Ring = @(($left - 4), ($bottom + 4)); Inside = @(($left + 48), ($bottom - 48)) },
        @{ Name = '右下'; Corner = @(($right - 2), ($bottom - 2)); Ring = @(($right + 4), ($bottom + 4)); Inside = @(($right - 48), ($bottom - 48)) }
      )
      $checked = @(); $skipped = @()
      foreach ($corner in $corners) {
        $points = @($corner.Corner, $corner.Inside)
        $onScreen = $true
        foreach ($point in $points) {
          if ($point[0] -lt $originX -or $point[1] -lt $originY -or ($point[0] - $originX) -ge $width -or ($point[1] - $originY) -ge $height) { $onScreen = $false }
        }
        if (-not $onScreen) { $skipped += $corner.Name; continue }
        # 环带在窗口外面，藏窗前后都该是同一层桌面；对不上说明那一下被别的窗口抢到前面了。
        # 窗口贴着屏幕边时环带本身就在屏外，这时它不参与判定（判定只看角与纸面内侧两点）。
        $ring = $corner.Ring
        if ($ring[0] -ge $originX -and $ring[1] -ge $originY -and ($ring[0] - $originX) -lt $width -and ($ring[1] - $originY) -lt $height) {
          if (-not (Test-SamePixel $withWindow $behind $ring[0] $ring[1] $originX $originY)) {
            throw "$($corner.Name)角外的环带在藏窗前后不是同一层：$Label 藏起来那一下有别的窗口抢到前面，比对不成立（$CaptureName / $behindName）"
          }
        }
        if (-not (Test-SamePixel $withWindow $behind $corner.Corner[0] $corner.Corner[1] $originX $originY)) {
          throw "$($corner.Name)角没有透出窗口背后那一层：$Label 的圆角透明未生效（比对 $CaptureName 与 $behindName）"
        }
        if (Test-SamePixel $withWindow $behind $corner.Inside[0] $corner.Inside[1] $originX $originY) {
          throw "$($corner.Name)角的纸面与背后同色：$Label 整面都是透的（比对 $CaptureName 与 $behindName）"
        }
        $checked += $corner.Name
      }
      # 屏外的角点名报出，不静默放行：少于两角就没有可比对的圆弧。
      if ($checked.Count -lt 2) { throw "$Label 只比对到 $($checked.Count) 个角（$($checked -join '、')），屏外跳过：$($skipped -join '、')；屏幕 $screen" }
      Write-Host "$Label 比对了 $($checked -join '、')：角上透出背后那一层，纸面本身不透。屏外跳过：$(if ($skipped.Count) { $skipped -join '、' } else { '无' })"
    } finally { $behind.Dispose() }
  } finally { $withWindow.Dispose() }
}
