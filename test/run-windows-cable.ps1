param([Parameter(Mandatory)][string]$Workspace, [switch]$CheckWasm)
$ErrorActionPreference = 'Stop'
$repo = Join-Path $Workspace 'retroarch-netplay-bridge'
$artifacts = Join-Path $Workspace 'result\netplay-interop\cable-20261107'
$work = Join-Path $env:LOCALAPPDATA 'RomMCableTest'
New-Item -ItemType Directory -Force $work | Out-Null
Copy-Item (Join-Path $Workspace 'result\netplay-interop\mgba-multi-rom\windows-bounded.exe') (Join-Path $work 'bounded.exe') -Force
if ($CheckWasm) {
    Copy-Item (Join-Path $Workspace '.cache\romm-headless-browser\node-windows.exe') (Join-Path $work 'node.exe') -Force
    Copy-Item (Join-Path $repo 'test\windows-cable-wasm.mjs') $work -Force
    foreach ($core in @('mgba','sameboy')) {
        Copy-Item (Join-Path $artifacts "$core\core-probe.mjs") (Join-Path $work $core) -Force
        Copy-Item (Join-Path $artifacts "$core\core-probe.wasm") (Join-Path $work $core) -Force
    }
    $arguments = @((Join-Path $work 'node.exe'), (Join-Path $work 'windows-cable-wasm.mjs'), $work) |
        ForEach-Object { '"' + $_ + '"' }
    $process = Start-Process -FilePath (Join-Path $work 'bounded.exe') -ArgumentList $arguments -WorkingDirectory $work -NoNewWindow -PassThru -Wait `
        -RedirectStandardOutput (Join-Path $work 'wasm.stdout.log') -RedirectStandardError (Join-Path $work 'wasm.stderr.log')
    Copy-Item (Join-Path $work 'wasm.*.log') (Join-Path $artifacts 'qualification') -Force
    Get-ChildItem $work -Filter '*-wasm.bin' | Copy-Item -Destination (Join-Path $artifacts 'qualification') -Force
    Get-Content (Join-Path $work 'wasm.stdout.log')
    Get-Content (Join-Path $work 'wasm.stderr.log')
    exit $process.ExitCode
}
foreach ($core in @('mgba','sameboy')) {
    $id = if ($core -eq 'mgba') { 'mgba_splitscreen' } else { 'sameboy' }
    $rom = if ($core -eq 'mgba') { 'gba-link-1.gba' } else { 'link-1.gb' }
    Copy-Item (Join-Path $artifacts "$core-probe.exe") $work -Force
    Copy-Item (Join-Path $artifacts "native-all\artifacts\$id\windows-x86_64\${id}_libretro.dll") (Join-Path $work "$core.dll") -Force
    Copy-Item (Join-Path $repo "test\fixtures\$rom") $work -Force
    $output = Join-Path $work $core
    New-Item -ItemType Directory -Force $output | Out-Null
    $arguments = @((Join-Path $work "$core-probe.exe"), (Join-Path $work "$core.dll"), (Join-Path $work $rom), 'cable', (Join-Path $output 'state')) |
        ForEach-Object { '"' + $_ + '"' }
    $process = Start-Process -FilePath (Join-Path $work 'bounded.exe') -ArgumentList $arguments -WorkingDirectory $work -NoNewWindow -PassThru -Wait `
        -RedirectStandardOutput (Join-Path $output 'stdout.log') -RedirectStandardError (Join-Path $output 'stderr.log')
    $evidence = Join-Path $artifacts "qualification\$core"
    New-Item -ItemType Directory -Force $evidence | Out-Null
    Copy-Item (Join-Path $output '*') $evidence -Force
    Write-Output "$core bounded probe exit: $($process.ExitCode)"
    Get-Content (Join-Path $output 'stdout.log') | Select-String '^\{'
    if ($process.ExitCode -ne 0) { Get-Content (Join-Path $output 'stderr.log') -Tail 12 }
    if ($process.ExitCode -ne 0) { exit $process.ExitCode }
}
