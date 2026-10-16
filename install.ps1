# InfiniteOC installer for Windows PowerShell (5.1 and 7+).
#   irm https://raw.githubusercontent.com/riz3y0/InfiniteOC/main/install.ps1 | iex
# Or download it first so you can read it, then run it. Nothing needs
# administrator: the install directory, the command shims and the PATH entry
# are all per-user. Read it before running it.
#
# Environment (or -Dir/-Bin/-Repo/-Ref parameters):
#   INFINITEOC_DIR       install directory            (default $env:LOCALAPPDATA\InfiniteOC)
#   INFINITEOC_BIN       where the command shims go    (default <install dir>\bin)
#   INFINITEOC_REPO      git URL                       (default https://github.com/riz3y0/InfiniteOC.git)
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

function Say([string]$Message) { Write-Host "[InfiniteOC] $Message" }
function Die([string]$Message) { Write-Error "[InfiniteOC] $Message"; exit 1 }

if ([string]::IsNullOrEmpty($Dir)) {
  $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
  $Dir = Join-Path $localAppData "InfiniteOC"
}
if ([string]::IsNullOrEmpty($Bin)) { $Bin = Join-Path $Dir "bin" }
if ([string]::IsNullOrEmpty($Repo)) { $Repo = "https://github.com/riz3y0/InfiniteOC.git" }
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
$major = (& node -p 'process.versions.node.split(".")[0]')
if ([int]$major -lt 22) { Die "Node.js 22 or newer is required (found $(& node -v))" }

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq "AMD64") { $arch = "x64" }
elseif ($arch -eq "ARM64") { $arch = "arm64" }
else { Die "unsupported architecture $arch; InfiniteOC runs on x64 and arm64" }
$Target = "win32-$arch"

if ((Test-Path (Join-Path $Dir ".git")) -and (Test-Path $Dir)) {
  Say "Updating $Dir"
  & git -C $Dir fetch --quiet origin $Ref
  if ($LASTEXITCODE -ne 0) { Die "git fetch failed" }
  & git -C $Dir merge --ff-only --quiet "origin/$Ref"
  if ($LASTEXITCODE -ne 0) { Die "$Dir has local changes or commits; update it yourself with git" }
} elseif ((Test-Path $Dir) -and ((Get-ChildItem $Dir -Force | Measure-Object).Count -gt 0)) {
  Die "$Dir exists and is not an InfiniteOC checkout; set INFINITEOC_DIR to another path"
} else {
  Say "Cloning $Repo into $Dir"
  & git clone --quiet --branch $Ref $Repo $Dir
  if ($LASTEXITCODE -ne 0) { Die "git clone failed" }
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
