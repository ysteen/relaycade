param([Parameter(Mandatory)][string]$Launcher)
$ErrorActionPreference = 'Stop'
. $Launcher -LibraryOnly
$connection = [Console]::ReadLine() | ConvertFrom-Json
$controlFile = if ($connection.PSObject.Properties['pauseFile']) { $connection.pauseFile } else { '' }
$tunnel = Start-NativeTunnel $connection '' $controlFile
if ($connection.PSObject.Properties['controlPort']) { $tunnel.AttachControl([int]$connection.controlPort) }
try {
    [Console]::WriteLine($tunnel.Port)
    while ($null -ne [Console]::ReadLine()) { }
} finally {
    $tunnel.Dispose()
}
