param(
  [ValidateSet('asar', 'exe')][string]$Mode = 'exe',
  [string]$AppExe,
  [string]$NewExe,
  [string]$Backup,
  [string]$Launcher,
  [string]$TargetFile,
  [string]$NewFile,
  [string]$BackupFile,
  [int]$TargetPid = 0,
  [int]$ParentPid = 0,
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'

function Write-Log([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch { }
}

function Replace-File([string]$Source, [string]$Target) {
  try {
    Copy-Item -LiteralPath $Source -Destination $Target -Force
    return
  } catch {
    Write-Log ("direct copy failed, in-place fallback: " + $_.Exception.Message)
  }
  $sourceStream = [System.IO.File]::Open($Source, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  $targetStream = [System.IO.File]::Open($Target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)
  try {
    $targetStream.SetLength(0)
    $sourceStream.CopyTo($targetStream)
    $targetStream.Flush()
  } finally {
    $targetStream.Close()
    $sourceStream.Close()
  }
}

if ($Mode -eq 'asar') {
  $target = $TargetFile
  $incoming = $NewFile
  $backupPath = $BackupFile
  $startExe = $Launcher
} else {
  $target = $AppExe
  $incoming = $NewExe
  $backupPath = $Backup
  $startExe = $AppExe
}

Write-Log "helper start mode=$Mode pid=$TargetPid target=$target new=$incoming"

try {
  foreach ($required in @($target, $incoming, $backupPath, $startExe)) {
    if ([string]::IsNullOrWhiteSpace($required)) { throw "missing required argument" }
  }
  if (-not (Test-Path -LiteralPath $incoming)) { throw "new file missing: $incoming" }
  if (-not (Test-Path -LiteralPath $target)) { throw "target file missing: $target" }
  $logDir = [System.IO.Path]::GetDirectoryName($LogPath)
  if ($logDir -and -not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

  $deadline = (Get-Date).AddSeconds(60)
  if ($TargetPid -gt 0) {
    while ((Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 400
    }
  }
  if ($ParentPid -gt 0) {
    $parentDeadline = (Get-Date).AddSeconds(20)
    while ((Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $parentDeadline) {
      Start-Sleep -Milliseconds 400
    }
  }
  Start-Sleep -Milliseconds 1000

  Copy-Item -LiteralPath $target -Destination $backupPath -Force
  Write-Log "backup created: $backupPath"

  Replace-File $incoming $target
  Write-Log "replaced $target"

  $workDir = [System.IO.Path]::GetDirectoryName($startExe)
  Start-Process -FilePath $startExe -WorkingDirectory $workDir
  Write-Log "new version started: $startExe"
} catch {
  Write-Log ("ERROR: " + $_.Exception.Message)
  if ((Test-Path -LiteralPath $backupPath) -and (Test-Path -LiteralPath $target)) {
    try {
      Replace-File $backupPath $target
      $workDir = [System.IO.Path]::GetDirectoryName($startExe)
      Start-Process -FilePath $startExe -WorkingDirectory $workDir
      Write-Log "rolled back and restarted"
    } catch {
      Write-Log ("ROLLBACK FAILED: " + $_.Exception.Message)
    }
  }
}
