# InfiniteOC uninstaller for Windows PowerShell (5.1 and 7+).
# Stops opendaemon, removes the command shims and deletes the install directory.
# Stock OpenCode is never touched: your providers, sessions and OpenCode config
# stay exactly as they are. Nothing needs administrator. Read it before running it.
#
#   .\uninstall.ps1 [-Yes] [-RemoveSettings]
# Environment (or -Dir/-Bin parameters):
#   INFINITEOC_DIR       install directory            (default $env:LOCALAPPDATA\InfiniteOC)
#   INFINITEOC_BIN       where the command shims are   (default <install dir>\bin)
param(
  [string]$Dir = $env:INFINITEOC_DIR,
  [string]$Bin = $env:INFINITEOC_BIN,
  [switch]$Yes,
  [switch]$RemoveSettings
)

$ErrorActionPreference = "Stop"

function Say([string]$Message) { Write-Host "[InfiniteOC] $Message" }
function Die([string]$Message) { Write-Error "[InfiniteOC] $Message"; exit 1 }

if ([string]::IsNullOrEmpty($Dir)) {
  $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
  $Dir = Join-Path $localAppData "InfiniteOC"
}
if ([string]::IsNullOrEmpty($Bin)) { $Bin = Join-Path $Dir "bin" }

if ([string]::IsNullOrEmpty($Dir) -or $Dir -eq "\" -or $Dir -eq "/") { Die "refusing to remove '$Dir'" }
if (-not (Test-Path (Join-Path $Dir "bin\infiniteoc.mjs"))) {
  Die "$Dir does not look like an InfiniteOC checkout (no bin\infiniteoc.mjs); set INFINITEOC_DIR to the right path"
}

if (-not $Yes) {
  $answer = Read-Host "[InfiniteOC] Remove $Dir and its commands? [y/N]"
  if ($answer -notmatch "^[Yy]") { Die "Not removed." }
}

# Stop the daemon first; a missing or already-stopped daemon is not an error.
$daemon = Join-Path $Dir "bin\opendaemon.mjs"
if ((Test-Path $daemon) -and (Get-Command node -ErrorAction SilentlyContinue)) {
  # Windows PowerShell 5.1 turns redirected native stderr into a terminating
  # error under ErrorActionPreference=Stop, so "not running" must not abort here.
  try { & node $daemon --home $Dir stop 2>$null } catch { }
}

foreach ($tool in @("infiniteoc", "opendaemon")) {
  $shim = Join-Path $Bin "$tool.cmd"
  if (Test-Path $shim) {
    Remove-Item $shim -Force
    Say "Removed $shim"
  }
}

# Drop our bin from the user PATH (HKCU), leaving every other entry alone.
if ($IsWindows -or $env:OS -eq "Windows_NT") {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($current) {
    $kept = ($current -split ";" | Where-Object { $_.TrimEnd("\") -ne $Bin.TrimEnd("\") -and $_ -ne "" }) -join ";"
    if ($kept -ne $current) {
      [Environment]::SetEnvironmentVariable("Path", $kept, "User")
      Say "Removed $Bin from your user PATH."
    }
  }
}

Remove-Item $Dir -Recurse -Force
Say "Removed $Dir"

$appData = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME "AppData\Roaming" }
$settings = Join-Path $appData "infiniteoc"
if ($RemoveSettings) {
  # The default settings home is ~/.config; remove both when asked.
  foreach ($dir in @($settings, (Join-Path $HOME ".config\infiniteoc"))) {
    if (Test-Path $dir) {
      Remove-Item $dir -Recurse -Force
      Say "Removed $dir"
    }
  }
} else {
  Say "Kept InfiniteOC settings (use -RemoveSettings to delete them too)"
}
Say "Stock OpenCode data was left untouched. Done."
