# Links addon\AHSnap into the game's AddOns folder, so edits here are live after /reload.
param([string]$Wow = "C:\BNET\World of Warcraft\_forever_")

$source = Join-Path $PSScriptRoot "addon\AHSnap"
$addons = Join-Path $Wow "Interface\AddOns"
$target = Join-Path $addons "AHSnap"

if (-not (Test-Path $addons)) { Write-Error "AddOns folder not found: $addons"; exit 1 }
if (Test-Path $target) {
    $item = Get-Item $target -Force
    if ($item.LinkType -eq "Junction") { Write-Host "Already installed: $target -> $($item.Target)"; exit 0 }
    Write-Error "$target already exists and is not a link. Remove it first."; exit 1
}
New-Item -ItemType Junction -Path $target -Target $source | Out-Null
Write-Host "Installed: $target -> $source"
Write-Host "Restart the game (or /reload if it was already listed) and enable AHSnap in the AddOns list."
