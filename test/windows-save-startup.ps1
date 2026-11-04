param(
    [Parameter(Mandatory)][string]$Probe,
    [Parameter(Mandatory)][string]$Core,
    [Parameter(Mandatory)][string]$Cartridge,
    [Parameter(Mandatory)][string]$BoundedRunner,
    [switch]$ExpectMissingSaveMemory
)
$ErrorActionPreference = 'Stop'
$directory = Join-Path $env:TEMP ('RomMSaveStartup-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $directory | Out-Null
try {
    Copy-Item -LiteralPath $Probe -Destination (Join-Path $directory 'probe.exe')
    Copy-Item -LiteralPath $Core -Destination (Join-Path $directory 'core.dll')
    Copy-Item -LiteralPath $Cartridge -Destination (Join-Path $directory 'fixture.gba')
    Copy-Item -LiteralPath $BoundedRunner -Destination (Join-Path $directory 'bounded.exe')
    $output = Join-Path $directory 'stdout.txt'
    $errors = Join-Path $directory 'stderr.txt'
    $arguments = @('probe.exe', 'core.dll', 'fixture.gba') | ForEach-Object { '"' + (Join-Path $directory $_) + '"' }
    $process = Start-Process -FilePath (Join-Path $directory 'bounded.exe') -ArgumentList ($arguments + @('save-startup')) -NoNewWindow -Wait -PassThru -RedirectStandardOutput $output -RedirectStandardError $errors
    $code = $process.ExitCode
    $stdout = [IO.File]::ReadAllText($output)
    $stderr = [IO.File]::ReadAllText($errors)
    if ($ExpectMissingSaveMemory) {
        if ($code -ne 1 -or -not $stderr.Contains('SRAM unavailable before first frame')) {
            throw "The old core did not reproduce missing save memory: $code $stderr"
        }
        Write-Host 'Original core reproduced missing SRAM before the first frame; no game frames ran.'
    } else {
        if ($code -ne 0) { throw "Save startup check failed: $code $stderr" }
        $report = @($stdout -split '\r?\n' | Where-Object { $_.StartsWith('{') })
        if ($report.Count -ne 1) { throw "Missing startup report: $stdout" }
        $result = $report[0] | ConvertFrom-Json
        if (-not $result.saveStartup -or $result.frames -ne 0 -or -not $result.initialStatePreservesSaves) { throw 'Invalid startup result' }
        Write-Host $report[0]
    }
} finally { Remove-Item -LiteralPath $directory -Recurse -Force }
