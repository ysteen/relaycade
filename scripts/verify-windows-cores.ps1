param([Parameter(Mandatory=$true)][string]$Workspace)
$ErrorActionPreference = 'Stop'
$source = Join-Path $Workspace 'result\netplay-interop\cross-platform'
$output = Join-Path $source 'windows-runtime'
$work = Join-Path $env:LOCALAPPDATA 'RomMNativeCoreTest'
New-Item -ItemType Directory -Force $work, $output | Out-Null
Copy-Item (Join-Path $Workspace 'result\netplay-interop\standalone\generated-gba-fixtures\gba-link-1.gba') (Join-Path $work 'fixture.gba') -Force
Copy-Item (Join-Path $Workspace 'retroarch-netplay-bridge\test\fixtures\two-pad.sfc') (Join-Path $work 'fixture.sfc') -Force
$results = @()
foreach ($target in @('windows-x86_64', 'windows-x86')) {
    foreach ($core in @('sameboy', 'mgba_splitscreen', 'snes9x')) {
        $exeName = "$target-$core.exe"
        Copy-Item (Join-Path $source "probes\$exeName") (Join-Path $work $exeName) -Force
        $dllName = "$target-$core.dll"
        Copy-Item (Join-Path $source "artifacts\$core\$target\${core}_libretro.dll") (Join-Path $work $dllName) -Force
        $modes = if ($core -eq 'sameboy') { @('info') } else { @('own', 'linux') }
        foreach ($mode in $modes) {
            $prefix = "$target-$core-$mode"
            if ($mode -eq 'info') {
                $arguments = @($dllName, 'info')
            } else {
                $rom = if ($core -eq 'snes9x') { 'fixture.sfc' } else { 'fixture.gba' }
                $arguments = @($dllName, $rom, $prefix)
                if ($mode -eq 'linux') {
                    $initial = "linux-$core-initial.bin"
                    Copy-Item (Join-Path $source "probes\$initial") (Join-Path $work $initial) -Force
                    $arguments += $initial
                }
            }
            $process = Start-Process -FilePath (Join-Path $work $exeName) -ArgumentList $arguments -WorkingDirectory $work -NoNewWindow -Wait -PassThru -RedirectStandardOutput (Join-Path $output "$prefix.stdout.log") -RedirectStandardError (Join-Path $output "$prefix.stderr.log")
            if ($process.ExitCode -ne 0) { throw "$prefix failed with code $($process.ExitCode). See $output." }
            $line = Get-Content (Join-Path $output "$prefix.stdout.log") | Where-Object { $_.StartsWith('{') } | Select-Object -Last 1
            if (-not $line) { throw "Missing result: $prefix" }
            $result = $line | ConvertFrom-Json
            $result | Add-Member target $target
            $result | Add-Member mode $mode
            $results += $result
            if ($mode -ne 'info') {
                Copy-Item (Join-Path $work "$prefix-*.bin") $output -Force
            }
            Write-Output "$prefix passed"
        }
    }
}
$results | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $output 'results.json')
