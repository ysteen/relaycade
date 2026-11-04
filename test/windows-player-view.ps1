param([string]$Launcher, [string]$Work)
$ErrorActionPreference = 'Stop'
. $Launcher -LibraryOnly

function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Write-Word([byte[]]$Bytes, [int]$At, [uint32]$Value) {
    $word = [BitConverter]::GetBytes($Value)
    [Array]::Reverse($word)
    [Array]::Copy($word, 0, $Bytes, $At, 4)
}
function Test-Relay([byte[]]$Packet, [string]$View, [string]$Expected) {
    $source = New-Object IO.MemoryStream(,$Packet)
    $destination = New-Object IO.MemoryStream
    try {
        [RomMNativeTunnel]::RelayServer($source, $destination, $View).GetAwaiter().GetResult() | Out-Null
        Assert ([Convert]::ToBase64String($Packet) -eq [Convert]::ToBase64String($destination.ToArray())) 'Relay changed protocol bytes'
        Assert ([IO.File]::ReadAllText($View) -eq $Expected) 'Wrong local player view'
    } finally { $source.Dispose(); $destination.Dispose() }
}

$view = Join-Path $Work 'player-view-test.txt'
[IO.File]::WriteAllText($view, '0')
$tunnel = Start-NativeTunnel @{ host = '127.0.0.1'; port = 1; password = 'test' } $view
try {
    $packet = New-Object byte[] 68
    Write-Word $packet 0 0x26
    Write-Word $packet 4 60
    Write-Word $packet 12 0x40000003
    Write-Word $packet 16 2
    Test-Relay $packet $view '0'
    for ($seat = 0; $seat -lt 4; $seat++) {
        Write-Word $packet 12 ([uint32]3221225475)
        Write-Word $packet 16 ([uint32](1 -shl $seat))
        Test-Relay $packet $view ([string]($seat + 1))
    }
    $large = New-Object byte[] (1048576 + 8)
    Write-Word $large 0 0x42
    Write-Word $large 4 1048576
    Test-Relay $large $view '4'
    Write-Word $packet 12 ([uint32]2147483651)
    Write-Word $packet 16 0
    Test-Relay $packet $view '0'
    Write-Host 'Player-view relay passed: own P1-P4, other members ignored, spectator hidden, large state packet unchanged.'
} finally { $tunnel.Dispose() }
