<#
  只读诊断：Windows 自绘安装包「双击没反应、也没报错」。
  用法（在出问题的那台机器上）：
    powershell -ExecutionPolicy Bypass -File diagnose-windows-installer.ps1 -Installer "$env:USERPROFILE\Downloads\astella-1.4.0-win-x64.exe"
  报告同时写到 %TEMP%\astella-installer-diagnostic.txt，把整份贴回来即可。
  不安装、不卸载、不写注册表；除了按 -NoLaunch 之外会真启动一次安装向导，然后关掉它。
#>
param(
  [string]$Installer,
  [switch]$NoLaunch,
  [switch]$ShellRun
)
$ErrorActionPreference = 'Continue'
if (-not $Installer) {
  $guess = Get-ChildItem (Join-Path $PSScriptRoot '..\release') -Filter 'astella-*-win-x64.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($guess) { $Installer = $guess.FullName } else { throw '缺少 -Installer，请指向安装包 .exe 的完整路径。' }
}
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$Text) { $lines.Add($Text); Write-Host $Text }
function Section([string]$Title) { Say ''; Say ('== ' + $Title + ' ==') }

$windowSeen = $false; $exitCode = $null; $elapsedMs = $null
$stderrText = ''; $stdoutText = ''
$footerFound = $false; $mzValid = $false

Section '0 基本环境'
Say ('主机 {0} · {1} · CLR {2}' -f $env:COMPUTERNAME, [Environment]::OSVersion.VersionString, [Environment]::Version)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Say ('用户 {0} · 管理员 {1} · 会话 {2} · 区域 {3}' -f $env:USERNAME, $isAdmin, (Get-Process -Id $PID).SessionId, (Get-Culture).Name)

Section '1 安装包文件本身'
$info = Get-Item -LiteralPath $Installer
Say ('路径 {0}' -f $info.FullName)
Say ('大小 {0} 字节（{1:N0} MB）· 修改时间 {2:u}' -f $info.Length, ($info.Length / 1MB), $info.LastWriteTime)
Say ('文件版本 {0} · 产品 {1}' -f $info.VersionInfo.FileVersion, $info.VersionInfo.ProductName)
$sig = Get-AuthenticodeSignature -LiteralPath $Installer
$signer = '无证书'
if ($sig.SignerCertificate) { $signer = $sig.SignerCertificate.Subject }
Say ('Authenticode {0} · {1}' -f $sig.Status, $signer)
$motw = Get-Content -LiteralPath $Installer -Stream Zone.Identifier -ErrorAction SilentlyContinue
if ($motw) { Say ('网络来源标记 Zone.Identifier：' + ($motw -join ' / ')) } else { Say '网络来源标记：无' }

$fs = [System.IO.File]::OpenRead($Installer)
try {
  $dos = New-Object byte[] 64
  $fs.Read($dos, 0, 64) | Out-Null
  $mzValid = ($dos[0] -eq 0x4D -and $dos[1] -eq 0x5A)
  $peOff = [BitConverter]::ToInt32($dos, 60)
  if ($mzValid -and $peOff -gt 0 -and $peOff -lt ($fs.Length - 240)) {
    $fs.Position = $peOff
    $pe = New-Object byte[] 240
    $fs.Read($pe, 0, 240) | Out-Null
    $machine = [BitConverter]::ToUInt16($pe, 4)
    $magic = [BitConverter]::ToUInt16($pe, 24)
    $subsystem = [BitConverter]::ToUInt16($pe, 24 + 68)
    $certAt = $(if ($magic -eq 0x20b) { 168 } else { 152 })
    $certRva = [BitConverter]::ToInt32($pe, $certAt)
    $certSize = [BitConverter]::ToInt32($pe, $certAt + 4)
    $pe32 = 'PE32'
    if ($magic -eq 0x20b) { $pe32 = 'PE32+' }
    Say ('PE：MZ 有效 · machine=0x{0:X}（x64 应为 0x8664）· {1} · 子系统={2}（2=GUI，出错不显示任何文本）· 签名目录 {3}+{4}' -f $machine, $pe32, $subsystem, $certRva, $certSize)
  } else {
    Say ('MZ 头有效={0}，PE 偏移 {1} 不可用 —— 文件不是完整的 Windows 可执行文件。' -f $mzValid, $peOff)
  }

  $tailLen = [Math]::Min(4096, $fs.Length)
  $tail = New-Object byte[] $tailLen
  $fs.Position = $fs.Length - $tailLen
  $fs.Read($tail, 0, $tailLen) | Out-Null
  $at = [Text.Encoding]::ASCII.GetString($tail).LastIndexOf('ASTELLA1')
  if ($at -lt 0) {
    Say '尾部标记 ASTELLA1：没找到 —— 文件被截断、被改写，或不是这条打包流程的产物。'
  } else {
    $footerFound = $true
    $jsonSize = [BitConverter]::ToInt64($tail, $at - 16)
    $zipSize = [BitConverter]::ToInt64($tail, $at - 8)
    $after = $tailLen - ($at + 8)
    $apphost = $info.Length - $zipSize - $jsonSize - 24 - $after
    $marker = '正常'
    if ($apphost -lt (20MB) -or $apphost -gt (200MB)) { $marker = '⚠ 不在正常区间（约 66 MB），可能在下载中被截断或补零' }
    Say ('尾部标记：EOF-{3} 字节处 · zip={0:N0} 清单={1:N0} 推得自解压壳={2:N0} 字节 {4}' -f $zipSize, $jsonSize, $apphost, $after, $marker)
    $json = New-Object byte[] $jsonSize
    $fs.Position = $fs.Length - $after - 24 - $jsonSize
    $fs.Read($json, 0, $jsonSize) | Out-Null
    $man = [Text.Encoding]::UTF8.GetString($json) | ConvertFrom-Json
    Say ('清单：版本={0} 架构={1} 解压后={2:N0} 字节 文件数={3} zipSha256={4}' -f $man.version, $man.arch, $man.size, @($man.files).Count, $man.sha256)
  }
} finally { $fs.Dispose() }

Section '2 启动前置条件'
foreach ($probe in @($env:TEMP, $info.DirectoryName)) {
  $root = [IO.Path]::GetPathRoot($probe)
  $free = '未知'
  try { $free = ('{0:N1} GB' -f ([System.IO.DriveInfo]::new($root).AvailableFreeSpace / 1GB)) } catch { }
  Say ('{0} 所在盘剩余 {1}' -f $probe, $free)
}
try {
  $probeFile = Join-Path $env:TEMP ('astella-write-probe-' + [guid]::NewGuid().ToString('N'))
  Set-Content -LiteralPath $probeFile -Value 'x' -ErrorAction Stop
  Remove-Item -LiteralPath $probeFile -Force
  Say '临时目录可写。'
} catch { Say ('⚠ 临时目录不可写：' + $_.Exception.Message) }
$extract = Join-Path $env:TEMP '.net\AstellaSetup'
if (Test-Path -LiteralPath $extract) {
  $dirs = @(Get-ChildItem -LiteralPath $extract -Directory -ErrorAction SilentlyContinue)
  Say ('单文件解包目录 {0} 里有 {1} 份残留：' -f $extract, $dirs.Count)
  foreach ($d in $dirs) {
    $locked = ''
    try {
      $h = [System.IO.File]::Open((Join-Path $d.FullName 'coreclr.dll'), 'Open', 'Read', 'None')
      $h.Close()
    } catch [System.IO.FileNotFoundException] { } catch { $locked = ' · 被其他进程占用' }
    $sizeMb = (Get-ChildItem -LiteralPath $d.FullName -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB
    Say ('  {0} · {1:N1} MB · {2:u}{3}' -f $d.Name, $sizeMb, $d.LastWriteTime, $locked)
  }
  Say '  如果这里有被占用或半截的目录，每次启动都会在同一处失败；GUI 子系统不会把这条失败显示出来。'
} else { Say '单文件解包目录（%TEMP%\.net\AstellaSetup）不存在。' }
$same = @(Get-Process -Name 'AstellaSetup', 'Astella' -ErrorAction SilentlyContinue)
if ($same.Count) { Say ('⚠ 已有相关进程：' + (($same | ForEach-Object { $_.Id.ToString() + ' ' + $_.ProcessName }) -join '; ')) } else { Say '没有残留的安装/应用进程。' }
$mutexName = 'Local\Astella.Setup.' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$held = $false
try { $m = [System.Threading.Mutex]::OpenExisting($mutexName); $m.Close(); $held = $true } catch { }
if ($held) { Say ('⚠ 安装互斥锁仍被持有：' + $mutexName + ' —— 有进程没退干净。') } else { Say '安装互斥锁空闲。' }

Section '3 实跑一次（重定向标准错误，能看到进入托管代码之前的失败原因）'
if ($NoLaunch) { Say '按 -NoLaunch 跳过。' } else {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $start = [Diagnostics.ProcessStartInfo]::new($Installer)
  $start.UseShellExecute = $false
  $start.WorkingDirectory = $info.DirectoryName
  $start.RedirectStandardError = $true
  $start.RedirectStandardOutput = $true
  $start.CreateNoWindow = $true
  try {
    $p = [Diagnostics.Process]::Start($start)
    while ($sw.ElapsedMilliseconds -lt 120000) {
      $p.Refresh()
      if ($p.MainWindowHandle -ne 0) { $windowSeen = $true; break }
      if ($p.HasExited) { break }
      Start-Sleep -Milliseconds 250
    }
    $elapsedMs = [int]$sw.ElapsedMilliseconds
    if (-not $windowSeen -and -not $p.HasExited) { Say '120 秒内既没有窗口也没有退出 —— 进程活着但没出界面。' }
    if (-not $p.HasExited) { $p.Kill(); $p.WaitForExit(5000) | Out-Null }
    $exitCode = $p.ExitCode
    $stdoutText = $p.StandardOutput.ReadToEnd()
    $stderrText = $p.StandardError.ReadToEnd()
    $p.Dispose()
  } catch { Say ('⚠ 进程根本没创建成功：' + $_.Exception.Message) }
  $exitHex = ''
  if ($null -ne $exitCode) { $exitHex = '0x{0:X}' -f [Int32]$exitCode }
  Say ('耗时 {0} ms · 退出码 {1}（{2}）· 窗口出现 {3}' -f $elapsedMs, $exitCode, $exitHex, $windowSeen)
  if ($stderrText.Trim()) { Say ('标准错误：' + $stderrText.Trim()) } else { Say '标准错误：空' }
  if ($stdoutText.Trim()) { Say ('标准输出：' + $stdoutText.Trim()) }
}
if ($ShellRun) {
  Section '3b 走资源管理器同一条路（UseShellExecute，会触发 SmartScreen 与阻止策略）'
  try {
    $sp = Start-Process -FilePath $Installer -PassThru -WorkingDirectory $info.DirectoryName
    Start-Sleep -Seconds 20
    $sp.Refresh()
    Say ('ShellExecute pid={0} 已退出={1} 窗口={2}' -f $sp.Id, $sp.HasExited, ($sp.MainWindowHandle -ne 0))
    if (-not $sp.HasExited) { Stop-Process -Id $sp.Id -Force }
  } catch { Say ('⚠ ShellExecute 启动失败：' + $_.Exception.Message) }
}

Section '4 托管代码走到了哪一层'
$logs = Join-Path $env:LOCALAPPDATA 'Astella\setup-logs'
$heartbeat = Join-Path $logs 'startup.log'
$ranMain = $false
if (Test-Path -LiteralPath $heartbeat) {
  $ranMain = $true
  Say '启动心跳（Program.Main 第一行）最近三次：'
  foreach ($row in @(Get-Content -LiteralPath $heartbeat -ErrorAction SilentlyContinue | Select-Object -Last 3)) { Say ('  ' + $row) }
} else {
  Say '没有 startup.log 心跳 —— 托管 Main 一次都没进过，故障在 .NET 启动器或系统层，安装器自己的错误处理无从执行。'
}
$failures = @(Get-ChildItem -LiteralPath $logs -File -Filter '2*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
if ($failures.Count) {
  foreach ($f in $failures | Select-Object -First 3) {
    Say ('{0:u}  {1}' -f $f.LastWriteTime, $f.Name)
    Say ('  ' + ((Get-Content -LiteralPath $f.FullName -TotalCount 3 -ErrorAction SilentlyContinue) -join ' | '))
  }
} elseif ($ranMain) {
  Say '有心跳但没有失败记录 —— 进了 Main 也没抛异常，问题在界面呈现或窗口之外。'
}

Section '5 有没有被安全软件或系统拦截'
try {
  $av = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop | ForEach-Object { $_.displayName })
  if ($av.Count) { Say ('已注册的安全产品：' + ($av -join '; ')) } else { Say '已注册的安全产品：无' }
} catch { Say '查不到安全产品信息（SecurityCenter2 不可访问）。' }
try {
  $d = Get-MpComputerStatus -ErrorAction Stop
  Say ('Defender 实时保护={0} 服务={1} 受控文件夹={2}' -f $d.RealTimeProtectionEnabled, $d.AMServiceEnabled, $d.EnableControlledFolderAccess)
  $t = @(Get-MpThreatDetection -ErrorAction SilentlyContinue | Where-Object { $_.InitialDetectionTime -gt [DateTime]::Now.AddDays(-3) })
  foreach ($x in $t) { Say ('⚠ 近期检出 id={0} · 资源 {1} · 时间 {2:u}' -f $x.ThreatID, (($x.Resources) -join ';'), $x.InitialDetectionTime) }
  if (-not $t.Count) { Say 'Defender 近 3 天无检出记录。' }
} catch { Say 'Defender 状态查不到（通常是被第三方安全软件接管）。' }
foreach ($name in @('Application', 'System')) {
  $ev = @(Get-WinEvent -FilterHashtable @{ LogName = $name; StartTime = [DateTime]::Now.AddMinutes(-60); Level = 1, 2, 3 } -ErrorAction SilentlyContinue |
    Where-Object { $_.ProviderName -match '\.NET|Application Error|Windows Error Reporting|CodeIntegrity|Defender|Filter|AppModel' } | Select-Object -First 6)
  if ($ev.Count) {
    foreach ($e in $ev) { Say ('{0} · {1} · id {2} · {3}' -f $name, $e.ProviderName, $e.Id, (($e.Message -split "`r?`n")[0])) }
  } else { Say ('{0} 近 60 分钟没有相关错误事件。' -f $name) }
}

Section '6 这份报告怎么读'
if (-not $mzValid) {
  Say '文件连 MZ 头都不对 —— 重新下载，别在这台机器上继续排查。'
} elseif (-not $footerFound) {
  Say '缺 ASTELLA1 尾部标记 —— 下载不完整或被改写；先在另一台机器上校验同一份文件。'
} elseif ($windowSeen) {
  Say '向导能起来 —— exe 没问题，卡的是双击那条路（SmartScreen／安全软件／下载目录／文件关联）。加 -ShellRun 再跑一次对比。'
} elseif (-not $ranMain) {
  Say '第 3 节跑过之后仍没有心跳 —— 托管 Main 没进去，原因在第 2 节（临时目录解包）或第 5 节（被安全软件拦下），不在应用代码里。'
} elseif ($stderrText.Trim()) {
  Say '进入托管代码之前就有错误文本，上面那段就是原因（多半是 %TEMP% 解包失败或被占用）。'
} elseif ($null -ne $exitCode -and $exitCode -ne 0) {
  Say ('进程带着退出码 {0}（0x{1:X}）退出了 —— 按这个码查（0xC0000005 崩溃、0xC0000142 初始化失败、1 是我们的异常分支）。' -f $exitCode, $exitCode)
} else {
  Say '进程活着却没窗口，或根本没创建成功 —— 结合第 5 节的安全软件与事件日志判断。'
}
$signed = '未签名'
if ($sig.Status -eq 'Valid') { $signed = '已签名' }
Say ('补充：这份包 {0:N0} MB、{1}。数百 MB 的自解压单文件 exe 在未签名时，正是安全软件最爱静默拦下来的形状。' -f ($info.Length / 1MB), $signed)

$out = Join-Path $env:TEMP 'astella-installer-diagnostic.txt'
Set-Content -LiteralPath $out -Value $lines -Encoding UTF8
Write-Host ''
Write-Host ('完整报告：' + $out)
