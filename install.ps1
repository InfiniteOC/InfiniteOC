# InfiniteOC installer for Windows PowerShell (5.1 and 7+).
#
# The repository is private: only people the owner invited can install it, and
# cloning needs credentials. The GitHub CLI is the easiest source of them:
#   gh auth login
#   (gh api -H "Accept: application/vnd.github.raw" `
#      /repos/InfiniteOC/InfiniteOC/contents/install.ps1) | iex   # read it first
# or clone first and run the copy you can read:
#   gh repo clone InfiniteOC/InfiniteOC "$HOME\.infiniteoc"; & "$HOME\.infiniteoc\install.ps1"
# GH_TOKEN/GITHUB_TOKEN work with gh too. Nothing needs administrator: the
# install directory, the command shims and the PATH entry are all per-user.
# Read it before running it.
#
# Environment (or -Dir/-Bin/-Repo/-Ref parameters):
#   INFINITEOC_DIR       install directory            (default $env:LOCALAPPDATA\InfiniteOC)
#   INFINITEOC_BIN       where the command shims go    (default <install dir>\bin)
#   INFINITEOC_REPO      git URL                       (default https://github.com/InfiniteOC/InfiniteOC.git)
#   INFINITEOC_REF       branch to track               (default main)
#   INFINITEOC_NO_SETUP  1 = skip the first build (it takes several minutes)
#   INFINITEOC_PREBUILT  0 = never download a prebuilt binary; always build from source
#   INFINITEOC_VERSION   release tag for the prebuilt binary (default: latest release)
param(
  [string]$Dir = $env:INFINITEOC_DIR,
  [string]$Bin = $env:INFINITEOC_BIN,
  [string]$Repo = $env:INFINITEOC_REPO,
  [string]$Ref = $env:INFINITEOC_REF
)

$ErrorActionPreference = "Stop"

# Colors and a spinner in an interactive console (not with NO_COLOR or redirected output); plain lines otherwise.
$Fx = -not $env:NO_COLOR -and -not [Console]::IsOutputRedirected
function Say([string]$Message) {
  if ($Fx) { Write-Host "◆ " -ForegroundColor Magenta -NoNewline; Write-Host $Message } else { Write-Host "[InfiniteOC] $Message" }
}
function Die([string]$Message) {
  if ($Fx) { Write-Host "✗ " -ForegroundColor Red -NoNewline; Write-Host $Message }
  Write-Error "[InfiniteOC] $Message"; exit 1
}
# Runs a command with its output in a log behind a spinner; a check mark, or a cross with the log's last lines.
# Returns the command's exit code.
function Step([string]$Label, [string]$Command, [string[]]$Arguments) {
  $log = [IO.Path]::GetTempFileName()
  $err = [IO.Path]::GetTempFileName()
  $process = Start-Process -FilePath $Command -ArgumentList $Arguments -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError $err
  $frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".ToCharArray()
  $i = 0
  if (-not $Fx) { Write-Host "[InfiniteOC] $Label..." }
  while (-not $process.HasExited) {
    if ($Fx) { Write-Host ("`r" + $frames[$i % 10] + " $Label " + [int]($i / 10) + "s") -NoNewline -ForegroundColor Magenta }
    $i++
    Start-Sleep -Milliseconds 100
  }
  $process.WaitForExit()
  $code = $process.ExitCode
  if ($Fx) { Write-Host ("`r" + (" " * ($Label.Length + 12)) + "`r") -NoNewline }
  if ($code -eq 0) {
    if ($Fx) { Write-Host "✓ " -ForegroundColor Green -NoNewline; Write-Host $Label }
  } else {
    if ($Fx) { Write-Host "✗ " -ForegroundColor Red -NoNewline; Write-Host $Label } else { Write-Host "[InfiniteOC] $Label failed" }
    Get-Content $log, $err -ErrorAction SilentlyContinue | Select-Object -Last 15 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
  }
  Remove-Item $log, $err -ErrorAction SilentlyContinue
  return $code
}
if ($Fx) { Write-Host ""; Write-Host "◆ Infinite" -ForegroundColor Magenta -NoNewline; Write-Host "OC" -ForegroundColor Red -NoNewline; Write-Host " installer" -ForegroundColor DarkGray; Write-Host "" }

if ([string]::IsNullOrEmpty($Dir)) {
  $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
  $Dir = Join-Path $localAppData "InfiniteOC"
}
if ([string]::IsNullOrEmpty($Bin)) { $Bin = Join-Path $Dir "bin" }
if ([string]::IsNullOrEmpty($Repo)) { $Repo = "https://github.com/InfiniteOC/InfiniteOC.git" }
if ([string]::IsNullOrEmpty($Ref)) { $Ref = "main" }

# Administrator is never required. Warn when elevated so a sudo mishap does not
# leave root-owned files in a user directory.
try {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Say "Running as administrator, which is not needed. Installing per-user anyway."
  }
} catch { }

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) { Die "git is required (https://git-scm.com)" }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die "Node.js 22 or newer is required (https://nodejs.org)" }
$nodeVersion = ((& node -v) | Out-String).Trim()
$major = ($nodeVersion.TrimStart('v').Split('.')[0])
if ([int]$major -lt 22) { Die "Node.js 22 or newer is required (found $nodeVersion)" }

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq "AMD64") { $arch = "x64" }
elseif ($arch -eq "ARM64") { $arch = "arm64" }
else { Die "unsupported architecture $arch; InfiniteOC runs on x64 and arm64" }
$Target = "win32-$arch"

# The repository is private, so cloning and updating need credentials. When the
# GitHub CLI is installed and signed in (gh auth login), wire it into git's
# credential helper so plain git clone/fetch authenticate; gh uses
# GH_TOKEN/GITHUB_TOKEN too.
$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($gh) {
  try {
    & gh auth status *> $null
    if ($LASTEXITCODE -eq 0) { & gh auth setup-git *> $null }
  } catch { }
}

if ((Test-Path (Join-Path $Dir ".git")) -and (Test-Path $Dir)) {
  # InfiniteOC's own updater: it fetches a moved OpenCode pin before the code moves, rebuilds, and rolls back to
  # the previous version if the new one does not build.
  Say "Updating $Dir"
  & node "$Dir\bin\infiniteoc.mjs" update
  if ($LASTEXITCODE -ne 0) { Die "update failed; $Dir is unchanged or back on its previous version (see above)" }
} elseif ((Test-Path $Dir) -and ((Get-ChildItem $Dir -Force | Measure-Object).Count -gt 0)) {
  Die "$Dir exists and is not an InfiniteOC checkout; set INFINITEOC_DIR to another path"
} else {
  $cloned = Step "Cloning $Repo into $Dir" "git" @("clone", "--quiet", "--branch", $Ref, $Repo, "`"$Dir`"")
  if ($cloned -ne 0) { Die "clone failed: $Repo is private; run 'gh auth login' (then 'gh auth setup-git'), set GH_TOKEN, or set INFINITEOC_REPO to an SSH URL" }
}

# An install is not a development clone: nothing here is ever pushed to the InfiniteOC repository, even when
# an agent commits in it. Personal mods belong in ~/.config/infiniteoc/mods (infiniteoc feature new ID), and
# the auto-updater only fetches, so this blocks nothing it needs. git push fails with this path as the reason.
& git -C $Dir config remote.origin.pushurl "/infiniteoc-install-is-read-only--put-personal-mods-in-~/.config/infiniteoc/mods"

New-Item -ItemType Directory -Force -Path $Bin | Out-Null
foreach ($tool in @("infiniteoc", "opendaemon")) {
  $shim = Join-Path $Bin "$tool.cmd"
  "@echo off`r`nnode `"$Dir\bin\$tool.mjs`" %*`r`n" | Out-File -FilePath $shim -Encoding ascii -NoNewline
}
Say "Created infiniteoc.cmd and opendaemon.cmd in $Bin"

# Per-user PATH (HKCU), never the machine PATH: no elevation needed.
# install.ps1 targets Windows; on any other OS this step is skipped.
if ($IsWindows -or $env:OS -eq "Windows_NT") {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($current -split ";" | ForEach-Object { $_.TrimEnd("\") }) -notcontains $Bin.TrimEnd("\")) {
    [Environment]::SetEnvironmentVariable("Path", "$current;$Bin", "User")
    $env:Path = "$env:Path;$Bin"
    Say "Added $Bin to your user PATH. Restart your terminal to use it everywhere."
  }
} else {
  Say "Not on Windows; skipping the PATH entry ($Bin was still created)."
}

if ($env:INFINITEOC_NO_SETUP -eq "1") {
  Say "Skipping the first build. Run 'infiniteoc setup' (several minutes) or just 'infiniteoc'."
} else {
  $prebuilt = $true
  if ($env:INFINITEOC_PREBUILT -eq "0") { $prebuilt = $false }
  else {
    $fetchArgs = @("$Dir\scripts\fetch-prebuilt.mjs", $Target)
    if ($env:INFINITEOC_VERSION) { $fetchArgs += @("--tag", $env:INFINITEOC_VERSION) }
    & node @fetchArgs
    if ($LASTEXITCODE -eq 0) {
      Say "Installed a prebuilt binary for $Target."
      Say "Running a verification build check (fast when the prebuilt binary is fresh)"
      & node "$Dir\bin\infiniteoc.mjs" setup
      if ($LASTEXITCODE -ne 0) { Die "infiniteoc setup failed" }
      Say "Done. Run: infiniteoc"
      return
    }
    Say "No prebuilt binary for $Target; building from source instead"
  }
  Say "Running the first build (several minutes; downloads Bun and OpenCode sources)"
  & node "$Dir\bin\infiniteoc.mjs" setup
  if ($LASTEXITCODE -ne 0) { Die "infiniteoc setup failed" }
}
Say "Done. Run: infiniteoc"
