# Free disk used by Paperlike build output.
# Usage:
#   .\clean.ps1            # delete build artifacts, keep node_modules
#   .\clean.ps1 -All       # also delete node_modules
#   .\clean.ps1 -WhatIf    # list what would be deleted
#   .\clean.ps1 -Force     # delete without asking
#
# Deletes, when present:
#   src-tauri\target
#   dist
#   *.pdb and Paperlike.exe in the project root
#   node_modules only with -All
#
# Does not delete your notes, this script, the source, or Paperlike.lnk.
# After a clean, the shortcut will not open until you run .\build.ps1 again.
param(
    [switch]$All,
    [switch]$WhatIf,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$Root = $PSScriptRoot

function Format-Bytes([int64]$Bytes) {
    if ($Bytes -lt 0) { return "unknown" }
    if ($Bytes -ge 1GB) { return "{0:N1} GB" -f ($Bytes / 1GB) }
    if ($Bytes -ge 1MB) { return "{0:N1} MB" -f ($Bytes / 1MB) }
    if ($Bytes -ge 1KB) { return "{0:N1} KB" -f ($Bytes / 1KB) }
    return "$Bytes B"
}

function Get-TreeBytes([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return [int64]0 }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return [int64](Get-Item -LiteralPath $Path -Force).Length
    }
    $dest = Join-Path $env:TEMP "paperlike-sizecheck"
    # robocopy's own exit code is 0-7 for a successful list. Force 0 so the script does not treat that as failure.
    $cmd = "robocopy `"$Path`" `"$dest`" /L /S /NJH /NFL /NDL /NC /NP /BYTES /XJ /R:0 /W:0 & exit /b 0"
    $out = & cmd.exe /c $cmd
    $line = @($out) | Where-Object { $_ -match "Bytes\s*:" } | Select-Object -First 1
    if ($line -and $line -match "Bytes\s*:\s*([0-9][0-9,\.]*)") {
        $digits = ($Matches[1] -replace "[^\d]", "")
        if ($digits) { return [int64]$digits }
    }
    return [int64]-1
}

function Remove-Tree([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        Remove-Item -LiteralPath $Path -Force
        return
    }
    $full = (Resolve-Path -LiteralPath $Path).ProviderPath
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & cmd.exe /c "rmdir /s /q `"$full`""
        if (Test-Path -LiteralPath $full) {
            & cmd.exe /c "rmdir /s /q `"\\?\$full`""
        }
    } finally {
        $ErrorActionPreference = $prev
    }
    if (Test-Path -LiteralPath $full) {
        throw "Could not delete $full. A file may be in use."
    }
}

function Get-VolumeFree([string]$Path) {
    $root = [System.IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $Path).Path)
    return [int64]([System.IO.DriveInfo]::new($root).AvailableFreeSpace)
}

$planned = New-Object System.Collections.Generic.List[object]
$planned.Add([pscustomobject]@{ Label = "src-tauri\target"; Path = Join-Path $Root "src-tauri\target" })
$planned.Add([pscustomobject]@{ Label = "dist"; Path = Join-Path $Root "dist" })
$rootExe = Join-Path $Root "Paperlike.exe"
if (Test-Path -LiteralPath $rootExe) {
    $planned.Add([pscustomobject]@{ Label = "Paperlike.exe"; Path = $rootExe })
}
Get-ChildItem -LiteralPath $Root -Filter "*.pdb" -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $planned.Add([pscustomobject]@{ Label = $_.Name; Path = $_.FullName })
}
if ($All) {
    $planned.Add([pscustomobject]@{ Label = "node_modules"; Path = Join-Path $Root "node_modules" })
}

Write-Host "Measuring build artifacts..."
$present = New-Object System.Collections.Generic.List[object]
foreach ($item in $planned) {
    if (Test-Path -LiteralPath $item.Path) {
        $bytes = Get-TreeBytes $item.Path
        $present.Add([pscustomobject]@{ Label = $item.Label; Path = $item.Path; Bytes = $bytes })
    }
}

Write-Host "Notes and the source stay. Paperlike.lnk stays too, and opens again after the next .\build.ps1."

if ($present.Count -eq 0) {
    Write-Host "Nothing to delete."
    if (-not $All -and (Test-Path -LiteralPath (Join-Path $Root "node_modules"))) {
        Write-Host "node_modules was kept. .\clean.ps1 -All removes it too."
    }
    exit 0
}

$total = [int64]0
foreach ($item in $present) {
    if ([int64]$item.Bytes -lt 0) { $total = -1; break }
    $total += [int64]$item.Bytes
}

Write-Host ""
foreach ($item in $present) {
    Write-Host ("  {0,-22} {1,10}" -f $item.Label, (Format-Bytes $item.Bytes))
    Write-Host ("  {0}" -f $item.Path)
}
Write-Host ("  {0,-22} {1,10}" -f "Total", (Format-Bytes $total))
Write-Host ""

if ($WhatIf -and $Force) {
    Write-Host "WhatIf is set, so nothing will be deleted."
}

if ($WhatIf) {
    $free = Get-VolumeFree $Root
    Write-Host ("Before:     {0}" -f (Format-Bytes $total))
    Write-Host ("After:      {0} (not deleted)" -f (Format-Bytes $total))
    Write-Host ("Would free: {0}" -f (Format-Bytes $total))
    Write-Host ("Drive free: {0}" -f (Format-Bytes $free))
    if (-not $All -and (Test-Path -LiteralPath (Join-Path $Root "node_modules"))) {
        Write-Host "node_modules was kept. .\clean.ps1 -All removes it too."
    }
    exit 0
}

if (-not $Force) {
    $where = ($present | ForEach-Object { $_.Path }) -join ", "
    $answer = Read-Host "Delete build artifacts under $where? [y/N]"
    if ($answer -notmatch "^(?i)y(es)?$") {
        Write-Host "Cancelled. Nothing deleted."
        exit 0
    }
}

$freeBefore = Get-VolumeFree $Root
foreach ($item in $present) {
    Write-Host "Deleting $($item.Path)"
    Remove-Tree $item.Path
}

$after = [int64]0
foreach ($item in $present) {
    if (-not (Test-Path -LiteralPath $item.Path)) { continue }
    $left = Get-TreeBytes $item.Path
    if ($left -lt 0) { $after = -1; break }
    $after += $left
}
$freed = if ($total -lt 0 -or $after -lt 0) { [int64]-1 } else { $total - $after }
$freeAfter = Get-VolumeFree $Root

Write-Host ""
Write-Host ("Before:     {0}" -f (Format-Bytes $total))
Write-Host ("After:      {0}" -f (Format-Bytes $after))
Write-Host ("Freed:      {0}" -f (Format-Bytes $freed))
Write-Host ("Drive free: {0} -> {1}" -f (Format-Bytes $freeBefore), (Format-Bytes $freeAfter))
if (-not $All -and (Test-Path -LiteralPath (Join-Path $Root "node_modules"))) {
    Write-Host "node_modules was kept. .\clean.ps1 -All removes it too."
}
