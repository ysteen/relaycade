param([Parameter(Mandatory)][string]$Launcher)
$ErrorActionPreference = 'Stop'
. $Launcher -LibraryOnly
$connection = [Console]::ReadLine() | ConvertFrom-Json
$tunnel = Start-NativeTunnel $connection ''
try {
    [Console]::WriteLine($tunnel.Port)
    while ($null -ne [Console]::ReadLine()) { }
} finally {
    $tunnel.Dispose()
}
