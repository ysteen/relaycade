param([string]$Launcher, [string]$Manifest, [string]$RetroArch, [string]$Root)
$ErrorActionPreference = 'Stop'
. $Launcher -LibraryOnly -Manifest $Manifest -RetroArch $RetroArch
$session = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
Assert-Session $session
$launch = Initialize-NativeSession $session $RetroArch $Root
$config = [IO.File]::ReadAllText((Join-Path $launch.Directory 'retroarch.cfg'))
if ($config.Contains($session.connection.password)) { throw 'Private room password leaked into RetroArch configuration' }
if ($launch.Arguments[-2] -notlike '*player-1.gba' -or $launch.Arguments[-1] -notlike '*player-2.gba') { throw 'Cartridge order changed' }
if ($launch.Arguments -notcontains 'gba_link_2p') { throw 'Missing link subsystem' }
foreach ($rom in $session.cartridges) {
    if ((Get-Sha256 (Join-Path $launch.Directory $rom.name)) -ne $rom.sha256) { throw 'ROM mismatch' }
}
$original = $session.expiresAt
$session.expiresAt = 0
$rejected = $false
try { Assert-Session $session } catch { $rejected = $true }
if (-not $rejected) { throw 'Expired manifest accepted' }
$session.expiresAt = $original
$original = $session.core.url
$session.core.url = 'https://untrusted.example/core.dll'
$rejected = $false
try { Assert-Session $session } catch { $rejected = $true }
if (-not $rejected) { throw 'Cross-origin core accepted' }
$session.core.url = $original
$launch | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Root 'prepared.json') -Encoding UTF8
Write-Host 'Windows preparation: hashes, ZIP extraction, ordered ROMs, isolated config, expiry and origin checks passed'
