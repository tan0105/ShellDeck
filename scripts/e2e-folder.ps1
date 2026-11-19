param(
  [string]$Folder = (Join-Path $PSScriptRoot '..\release\ShellDeck')
)

$ErrorActionPreference = 'Stop'
$launcher = Join-Path $Folder 'ShellDeck.exe'
$runtimeExe = Join-Path $Folder 'runtime\ShellDeckRuntime.exe'
$dataDir = Join-Path $Folder 'data'
$dbFile = Join-Path $dataDir 'ssh.db'

if (-not (Test-Path -LiteralPath $launcher)) { throw "launcher missing: $launcher" }
if (-not (Test-Path -LiteralPath $runtimeExe)) { throw "runtime missing: $runtimeExe" }

Get-Process ShellDeckRuntime, ShellDeck -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

$dataBackup = $null
if (Test-Path -LiteralPath $dataDir) {
  $dataBackup = Join-Path ([IO.Path]::GetTempPath()) ('shelldeck-e2e-data-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Copy-Item -LiteralPath $dataDir -Destination $dataBackup -Recurse -Force
  Write-Output ('[folder] data backed up: ' + $dataBackup)
  Remove-Item -LiteralPath $dataDir -Recurse -Force
}

$topFiles = @(Get-ChildItem -LiteralPath $Folder -File | Select-Object -ExpandProperty Name)
if ($topFiles.Count -ne 1 -or $topFiles[0] -ne 'ShellDeck.exe') {
  throw "top level should contain only ShellDeck.exe, got: $($topFiles -join ', ')"
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ShellDeckWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
    public int length; public int flags; public int showCmd;
    public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition;
  }
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@

function Get-WindowSize([IntPtr]$Handle) {
  $rect = New-Object ShellDeckWindow+RECT
  [ShellDeckWindow]::GetWindowRect($Handle, [ref]$rect) | Out-Null
  return "$($rect.Right - $rect.Left)x$($rect.Bottom - $rect.Top)"
}

function Get-ShowCommand([IntPtr]$Handle) {
  $placement = New-Object ShellDeckWindow+WINDOWPLACEMENT
  $placement.length = [Runtime.InteropServices.Marshal]::SizeOf($placement)
  [ShellDeckWindow]::GetWindowPlacement($Handle, [ref]$placement) | Out-Null
  return $placement.showCmd
}

function Get-AppWindow {
  return Get-Process ShellDeckRuntime -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
}

try {
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  Start-Process -FilePath $launcher | Out-Null
  $process = $null
  $dbTime = $null
  while ($watch.Elapsed.TotalSeconds -lt 30) {
    if (-not $process) { $process = Get-AppWindow }
    if (-not $dbTime -and (Test-Path -LiteralPath $dbFile)) { $dbTime = [math]::Round($watch.Elapsed.TotalSeconds, 2) }
    if ($process -and $dbTime) { break }
    Start-Sleep -Milliseconds 100
  }
  $firstWindow = [math]::Round($watch.Elapsed.TotalSeconds, 2)
  if (-not $process) { throw 'app window did not appear within 30s' }
  if (-not $dbTime) { throw 'top-level data/ssh.db was not created' }
  if (Test-Path -LiteralPath (Join-Path $Folder 'runtime\data')) { throw 'runtime\data should not be created' }

  [ShellDeckWindow]::ShowWindow($process.MainWindowHandle, 9) | Out-Null
  Start-Sleep -Milliseconds 600
  $process = Get-AppWindow
  $before = Get-ShowCommand $process.MainWindowHandle
  if ($before -eq 3) { throw 'window is still maximized before the second launch' }
  $sizeBefore = Get-WindowSize $process.MainWindowHandle

  $secondWatch = [System.Diagnostics.Stopwatch]::StartNew()
  $secondLauncher = Start-Process -FilePath $launcher -PassThru
  $secondLauncher.WaitForExit(10000) | Out-Null
  Start-Sleep -Milliseconds 800
  $secondElapsed = [math]::Round($secondWatch.Elapsed.TotalSeconds, 2)

  $current = Get-AppWindow
  if (-not $current) { throw 'app window disappeared after the second launch' }
  $afterShow = Get-ShowCommand $current.MainWindowHandle
  $sizeAfter = Get-WindowSize $current.MainWindowHandle
  if ($afterShow -eq 3) { throw 'second launch maximized the existing window' }
  if ($sizeAfter -ne $sizeBefore) { throw "second launch changed window size: $sizeBefore -> $sizeAfter" }
  $instances = @(Get-Process ShellDeckRuntime -ErrorAction SilentlyContinue).Count
  if ($instances -ne 1) { throw "expected one app instance, got $instances" }

  Write-Output ('[folder] dataDir seconds: ' + $dbTime)
  Write-Output ('[folder] first window seconds: ' + $firstWindow)
  Write-Output ('[folder] second launch seconds: ' + $secondElapsed + ' (not maximized, size preserved)')
  Write-Output '[folder] layout, data location and single-instance restore ok'
}
finally {
  Get-Process ShellDeckRuntime, ShellDeck -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if ($dataBackup -and (Test-Path -LiteralPath $dataBackup)) {
    if (Test-Path -LiteralPath $dataDir) { Remove-Item -LiteralPath $dataDir -Recurse -Force }
    Move-Item -LiteralPath $dataBackup -Destination $dataDir
    Write-Output '[folder] original data restored'
  }
}
