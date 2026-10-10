# 圆角透明的唯一判据：同一个屏幕位置，窗口在的时候与窗口藏起来的时候必须透出同一层。
#
# 原先拿「窗外邻居像素」当背后层参考，在真实桌面上不成立：任务栏上有图标和文字、壁纸有图案，
# 两个相邻像素本来就可以差很远。2026-10-10 在 CI 的 Windows runner 上，安装窗口贴到任务栏，
# 右下角明明已经透出背后那一层，却因为参考点落在任务栏的图标上被判成直角。
# 现在把窗口藏起来重拍同一块区域，参考就是它自己背后那一层，与桌面上是什么图案无关。

Add-Type -AssemblyName System.Drawing, System.Windows.Forms

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
  # 角必须整个落在屏幕里才可比对：主窗口初始 1440×810，比 runner 的工作区还大，
  # 原样摆着四个角都在屏外。先按工作区摆正（放不下才收小），摆不进就当场说清环境不行。
  $area = [System.Windows.Forms.SystemInformation]::WorkArea
  $outside = ($sheet.X -lt $area.X -or $sheet.Y -lt $area.Y -or ($sheet.X + $sheet.Width) -gt ($area.X + $area.Width) -or ($sheet.Y + $sheet.Height) -gt ($area.Y + $area.Height))
  if ($outside) {
    $width = [Math]::Min([int]$sheet.Width, [int]$area.Width)
    $height = [Math]::Min([int]$sheet.Height, [int]$area.Height)
    [Astella.Probe.Win32]::MoveWindow($Handle, [int]$area.X, [int]$area.Y, $width, $height, $true) | Out-Null
    Start-Sleep -Milliseconds 600
    $sheet = $Window.Current.BoundingRectangle
    Write-Host "$Label 原本超出工作区，已摆到 $sheet。"
  }
  if ($sheet.X -lt $area.X -or $sheet.Y -lt $area.Y -or ($sheet.X + $sheet.Width) -gt ($area.X + $area.Width) -or ($sheet.Y + $sheet.Height) -gt ($area.Y + $area.Height)) {
    throw "$Label 摆不进工作区，四个角无法逐个比对：窗口 $sheet / 工作区 $area"
  }
  $originX = [int]$sheet.X; $originY = [int]$sheet.Y
  $width = [int]$sheet.Width; $height = [int]$sheet.Height

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
      if ([int]$restored.X -ne $originX -or [int]$restored.Y -ne $originY) { throw "$Label 重新显示后位置变了：$sheet → $restored" }
      $behindName = $CaptureName -replace '\.png$', '-behind.png'
      $withWindow.Save((Join-Path $Diagnostics $CaptureName), [System.Drawing.Imaging.ImageFormat]::Png)
      $behind.Save((Join-Path $Diagnostics $behindName), [System.Drawing.Imaging.ImageFormat]::Png)
      $left = $originX; $top = $originY
      $right = $originX + $width - 1; $bottom = $originY + $height - 1
      $corners = @(
        @{ Name = '左上'; Corner = @(($left + 2), ($top + 2)); Inside = @(($left + 48), ($top + 48)) },
        @{ Name = '右上'; Corner = @(($right - 2), ($top + 2)); Inside = @(($right - 48), ($top + 48)) },
        @{ Name = '左下'; Corner = @(($left + 2), ($bottom - 2)); Inside = @(($left + 48), ($bottom - 48)) },
        @{ Name = '右下'; Corner = @(($right - 2), ($bottom - 2)); Inside = @(($right - 48), ($bottom - 48)) }
      )
      # 窗口已保证整个落在工作区里，且不小于 300×300，因此这四个角点与 48px 的内侧点必然在图内。
      foreach ($corner in $corners) {
        if (-not (Test-SamePixel $withWindow $behind $corner.Corner[0] $corner.Corner[1] $originX $originY)) {
          throw "$($corner.Name)角没有透出窗口背后那一层：$Label 的圆角透明未生效（比对 $CaptureName 与 $behindName）"
        }
        if (Test-SamePixel $withWindow $behind $corner.Inside[0] $corner.Inside[1] $originX $originY) {
          throw "$($corner.Name)角的纸面与背后同色：$Label 整面都是透的（比对 $CaptureName 与 $behindName）"
        }
      }
      Write-Host "$Label 四个角都透出背后那一层，纸面本身不透。"
    } finally { $behind.Dispose() }
  } finally { $withWindow.Dispose() }
}
