param([string]$Launcher)
$ErrorActionPreference = 'Stop'
. $Launcher -LibraryOnly
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Reject([scriptblock]$Action, [string]$Message) {
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    Assert $failed $Message
}
$id = [Guid]::NewGuid().ToString('N')
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('romm-launcher-test-' + $id)
$protocol = 'romm-netplay-test-' + $id
$key = 'HKCU:\Software\Classes\' + $protocol
try {
    $server = [PSCustomObject]@{ schemaVersion = 1; origin = 'https://romm.example:8443' }
    Register-Launcher $server $temporary $Launcher $protocol
    $installed = Join-Path $temporary 'Launcher\Launch.ps1'
    $configuration = Join-Path $temporary 'Launcher\servers.json'
    Assert ((Get-Sha256 $installed) -eq (Get-Sha256 $Launcher)) 'Registered helper differs from the downloaded source'
    $registration = Get-Item -LiteralPath $key
    Assert ($registration.GetValueNames() -contains 'URL Protocol') 'URL protocol marker is missing'
    $command = (Get-Item -LiteralPath ($key + '\shell\open\command')).GetValue('')
    Assert ($command.Contains('"' + $installed + '" -LaunchUri "%1"')) 'Protocol arguments are not quoted'
    $link = 'romm-netplay://launch/?server=https%3A%2F%2Fromm.example%3A8443&room=room-1&ticket=' + ('a' * 32)
    $request = Get-LaunchRequest $link $configuration
    Assert ($request.Origin -eq $server.origin -and $request.RoomId -eq 'room-1') 'Registered launch link was not parsed'
    foreach ($invalid in @(
        $link.Replace('romm.example', 'outside.example'),
        $link.Replace('room-1', '..%2Foutside'),
        $link.Replace('room-1', 'room-1" -Command bad'),
        ($link + '&command=bad'),
        ($link + '#fragment'),
        $link.Replace('https%3A%2F%2F', 'file%3A%2F%2F'),
        $link.Replace('romm.example%3A8443', 'user%3Apassword%40romm.example%3A8443'),
        $link.Replace(('a' * 32), 'expired')
    )) { Reject { Get-LaunchRequest $invalid $configuration } 'Unsafe or unregistered launch link was accepted' }
    Register-Launcher ([PSCustomObject]@{ schemaVersion = 1; origin = 'https://another.example' }) $temporary $Launcher $protocol
    Assert ((Get-Content -LiteralPath $configuration -Raw | ConvertFrom-Json).origins.Count -eq 2) 'Registering another server lost the first origin'
    Get-LaunchRequest $link $configuration | Out-Null
    Reject { Unregister-Launcher ($temporary + '-other') $protocol } 'A different launcher registration was removed'
    function Receive-SessionFile($Url, $Destination, $Credential, $Limit, $TimeoutMinutes, $Method) {
        Assert ($Method -eq 'POST') 'Launcher claim did not use POST'
        Assert ($Url -eq 'https://romm.example:8443/api/netplay/bridge/rooms/room-1/native/claim') 'Unexpected claim endpoint'
        Assert ($Credential -eq ('a' * 32)) 'Launch request credential was lost'
        [IO.File]::WriteAllText($Destination, '{"roomId":"room-1","origin":"https://romm.example:8443","pending":true}')
    }
    Assert ((Receive-LaunchSession $request $temporary).pending) 'Pending room bootstrap was lost'
    Assert (@(Get-ChildItem -LiteralPath $temporary -Filter 'launch-*.json').Count -eq 0) 'Temporary credential file was retained'
    Unregister-Launcher $temporary $protocol
    Assert (-not (Test-Path $key)) 'Per-user protocol registration was retained'
    Assert (Test-Path -LiteralPath $installed) 'Unregister removed cached session files'
    Write-Host 'Windows launcher registration passed: current-user test protocol, quoted command, persistent helper, registered origins, invalid links, single claim request and credential cleanup; no emulator launched.'
} finally {
    if (Test-Path $key) { Unregister-Launcher $temporary $protocol }
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
