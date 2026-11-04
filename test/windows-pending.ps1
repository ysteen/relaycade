param([string]$Launcher)
$ErrorActionPreference = 'Stop'
. $Launcher -LibraryOnly
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
$root = Join-Path $env:TEMP ('RomMManifestTest-' + [Guid]::NewGuid().ToString('N'))
$script:requests = 0
$script:pending = [pscustomobject]@{
    schemaVersion = 1; roomId = 'test-room'; credential = ('a' * 32)
    origin = 'https://romm.example'; platform = 'windows-x86_64'; pending = $true
    expiresAt = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 60000)
    manifestUrl = 'https://romm.example/api/netplay/bridge/rooms/test-room/native/manifest'
}
function Receive-SessionFile($Url, $Destination, $Credential, $Limit, $TimeoutMinutes) {
    Assert ($Url -eq $script:pending.manifestUrl) 'Wrong manifest endpoint'
    Assert ($Credential -eq $script:pending.credential) 'Missing scoped credential'
    $script:requests++
    $next = $script:pending | ConvertTo-Json | ConvertFrom-Json
    if ($script:requests -gt 1) {
        $next.pending = $false
        $next | Add-Member cartridges @([pscustomobject]@{romId=12}, [pscustomobject]@{romId=11})
    }
    [IO.File]::WriteAllText($Destination, ($next | ConvertTo-Json -Depth 8))
}
function Start-Sleep { param($Seconds) }
try {
    $result = Wait-SessionManifest $script:pending $root
    Assert ($script:requests -eq 2) 'Did not wait for preparation'
    Assert (-not $result.pending) 'Manifest stayed pending'
    Assert ($result.cartridges[0].romId -eq 12 -and $result.cartridges[1].romId -eq 11) 'Seat order changed'
    Assert (@(Get-ChildItem $root).Count -eq 0) 'Temporary credential file was not removed'
    $ready = [pscustomobject]@{schemaVersion=1}
    Assert ([object]::ReferenceEquals($ready, (Wait-SessionManifest $ready $root))) 'Legacy manifest changed'
    $script:pending.manifestUrl = 'https://other.example/native/manifest'
    $rejected = $false
    try { Wait-SessionManifest $script:pending $root | Out-Null } catch { $rejected = $_.Exception.Message -match 'Invalid room preparation' }
    Assert $rejected 'Foreign manifest URL accepted'
    Assert ($script:requests -eq 2) 'Credential was sent to a foreign origin'
    $script:pending.manifestUrl = 'https://romm.example/api/netplay/bridge/rooms/test-room/native/manifest'
    $script:pending.expiresAt = 0
    $rejected = $false
    try { Wait-SessionManifest $script:pending $root | Out-Null } catch { $rejected = $_.Exception.Message -match 'expired' }
    Assert $rejected 'Expired preparation accepted'
    Write-Host 'Pending manifest passed: waiting, seat order, scoped credential, origin validation, expiry and cleanup; no emulator launched.'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
