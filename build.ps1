# Build Paperlike, then put a Paperlike shortcut in this folder.
# Open PowerShell here and run:  .\build.ps1
#
# The first run downloads tools and compiles everything. That takes several minutes.
# Later runs are quicker. When it finishes, open Paperlike.lnk in this folder.
param()

$ErrorActionPreference = "Stop"
# Native tools (cargo, npm, signtool) report failure through $LASTEXITCODE.
$PSNativeCommandUseErrorActionPreference = $false
$Root = $PSScriptRoot
Set-Location $Root

function Get-SignToolPath {
    $cmd = Get-Command signtool -ErrorAction SilentlyContinue
    if (-not $cmd) { $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue }
    if ($cmd) { return $cmd.Source }
    return $null
}

function Test-SignStore([string]$Cert) {
    return ($Cert -match "^(?i)/a$") -or ($Cert -match "^(?i)store$")
}

function Get-AuthenticodeArgList([string]$Cert, [string]$Password) {
    $list = New-Object System.Collections.Generic.List[string]
    foreach ($part in @("sign", "/fd", "SHA256", "/tr", "http://timestamp.digicert.com", "/td", "SHA256")) {
        $list.Add($part)
    }
    if (Test-SignStore $Cert) {
        $list.Add("/a")
    } else {
        $list.Add("/f")
        $list.Add($Cert)
        if (-not [string]::IsNullOrEmpty($Password)) {
            $list.Add("/p")
            $list.Add($Password)
        }
    }
    return ,$list.ToArray()
}

function Write-ExeShortcut([string]$Shortcut, [string]$TargetPath) {
    $full = (Resolve-Path -LiteralPath $TargetPath).Path
    $shell = New-Object -ComObject WScript.Shell
    try {
        $link = $shell.CreateShortcut($Shortcut)
        $link.TargetPath = $full
        $link.WorkingDirectory = [System.IO.Path]::GetDirectoryName($full)
        $link.IconLocation = "$full,0"
        $link.Description = "Paperlike"
        $link.Save()
    } finally {
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
    }
}

Write-Host ""
Write-Host "Building Paperlike" -ForegroundColor Cyan
Write-Host "This folder: $Root"
Write-Host ""

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "Node.js is not installed. Install it from https://nodejs.org and then run this again."
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "Rust is not installed. Install it from https://rustup.rs and then run this again. Choose the MSVC toolchain."
}

if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    Write-Host "Downloading the pieces the app is built from. This happens once." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}

Write-Host "Building the window..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw "The window build failed." }

Write-Host "Building the app. The first time, this is the slow part." -ForegroundColor Cyan
cargo build --release --features custom-protocol --manifest-path (Join-Path $Root "src-tauri\Cargo.toml")
if ($LASTEXITCODE -ne 0) { throw "The app build failed." }

$ReleaseDir = Join-Path $Root "src-tauri\target\release"
$Candidates = @(
    (Join-Path $ReleaseDir "Paperlike.exe"),
    (Join-Path $ReleaseDir "paperlike-app.exe"),
    (Join-Path $ReleaseDir "paperlike_app.exe")
)
$Hits = @($Candidates | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { Get-Item -LiteralPath $_ } | Sort-Object LastWriteTime -Descending)
if ($Hits.Count -eq 0) {
    $Hits = @(Get-ChildItem -LiteralPath $ReleaseDir -Filter "*.exe" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch '(?i)(test|deps|build_script)' } |
        Sort-Object LastWriteTime -Descending)
}
if ($Hits.Count -eq 0) {
    throw "The build finished, but Paperlike.exe was not found in $ReleaseDir"
}
$Exe = $Hits[0].FullName
foreach ($stale in ($Hits | Select-Object -Skip 1)) {
    Remove-Item -LiteralPath $stale.FullName -Force -ErrorAction SilentlyContinue
}

$SignCert = ""
if ($null -ne $env:PAPERLIKE_SIGN_CERT) { $SignCert = $env:PAPERLIKE_SIGN_CERT.Trim() }
$SignPassword = $env:PAPERLIKE_SIGN_PASSWORD
if ($null -eq $SignPassword) { $SignPassword = "" }
if (-not [string]::IsNullOrWhiteSpace($SignCert)) {
    $SignTool = Get-SignToolPath
    if (-not $SignTool) {
        throw "PAPERLIKE_SIGN_CERT is set, but signtool is not on PATH."
    }
    if (-not (Test-SignStore $SignCert) -and -not (Test-Path -LiteralPath $SignCert)) {
        throw "PAPERLIKE_SIGN_CERT file not found: $SignCert"
    }
    $invoke = New-Object System.Collections.Generic.List[string]
    foreach ($part in (Get-AuthenticodeArgList $SignCert $SignPassword)) { $invoke.Add($part) }
    $invoke.Add($Exe)
    Write-Host "Signing the app..." -ForegroundColor Cyan
    & $SignTool @($invoke.ToArray())
    if ($LASTEXITCODE -ne 0) { throw "Signing failed." }
}

$Shortcut = Join-Path $Root "Paperlike.lnk"
Write-ExeShortcut $Shortcut $Exe
foreach ($stale in @(
    (Join-Path $Root "paperlike_local.lnk"),
    (Join-Path $Root "paperlike_setup.lnk"),
    (Join-Path $Root "paperlike_local.url"),
    (Join-Path $Root "paperlike_setup.url"),
    (Join-Path $Root "paperlike_local.exe.url"),
    (Join-Path $Root "paperlike_setup.exe.url"),
    (Join-Path $Root "Paperlike.exe")
)) {
    if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force }
}

$Version = "unknown"
$confPath = Join-Path $Root "src-tauri\tauri.conf.json"
if (Test-Path -LiteralPath $confPath) {
    $Version = [string](Get-Content -Raw -LiteralPath $confPath | ConvertFrom-Json).version
}
$SizeMb = "{0:N1}" -f ((Get-Item -LiteralPath $Exe).Length / 1MB)

Write-Host ""
Write-Host "Paperlike is ready." -ForegroundColor Green
Write-Host "Open this shortcut:  $Shortcut"
Write-Host "Version $Version, about $SizeMb MB."
Write-Host ""
Write-Host "Your notes are not stored in this folder. They stay in the notebooks you create, and app settings stay in %APPDATA%\Paperlike."
Write-Host ""
