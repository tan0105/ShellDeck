param(
  [Parameter(Mandatory = $true)][string]$AppExe,
  [Parameter(Mandatory = $true)][string]$NewExe,
  [Parameter(Mandatory = $true)][string]$Backup,
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [int]$ParentPid = 0,
  [Parameter(Mandatory = $true)][string]$LogPath
)

$ErrorActionPreference = 'Stop'

function Write-Log([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch { }
}

Write-Log "helper start pid=$TargetPid app=$AppExe new=$NewExe"

try {
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
  }
  if ($ParentPid -gt 0) {
    $parentDeadline = (Get-Date).AddSeconds(20)
    while ((Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $parentDeadline) {
      Start-Sleep -Milliseconds 400
    }
  }
  Start-Sleep -Milliseconds 1000

  if (-not (Test-Path -LiteralPath $NewExe)) { throw "new executable missing: $NewExe" }
  if (-not (Test-Path -LiteralPath $AppExe)) { throw "current executable missing: $AppExe" }

  Copy-Item -LiteralPath $AppExe -Destination $Backup -Force
  Write-Log "backup created: $Backup"

  Copy-Item -LiteralPath $NewExe -Destination $AppExe -Force
  Write-Log "replaced executable"

  $workDir = [System.IO.Path]::GetDirectoryName($AppExe)
  Start-Process -FilePath $AppExe -WorkingDirectory $workDir
  Write-Log "new version started"
} catch {
  Write-Log ("ERROR: " + $_.Exception.Message)
  if ((Test-Path -LiteralPath $Backup) -and (Test-Path -LiteralPath $AppExe)) {
    try {
      Copy-Item -LiteralPath $Backup -Destination $AppExe -Force
      $workDir = [System.IO.Path]::GetDirectoryName($AppExe)
      Start-Process -FilePath $AppExe -WorkingDirectory $workDir
      Write-Log "rolled back and restarted"
    } catch {
      Write-Log ("ROLLBACK FAILED: " + $_.Exception.Message)
    }
  }
}
