param(
    [Parameter(Mandatory)][string]$Workspace,
    [ValidateSet('fresh','rejoin','handoff','web-host','cable-browser','pacing')][string]$Scenario = 'fresh',
    [switch]$Diagnostic,
    [ValidatePattern('^[a-z0-9-]+$')][string]$Label,
    [string]$Content1,
    [string]$Content2
)
$ErrorActionPreference = 'Stop'
if (($Content1 -or $Content2) -and (-not $Content1 -or -not $Content2 -or $Scenario -ne 'cable-browser')) {
    throw 'External content requires both Content1 and Content2 with Scenario cable-browser.'
}
$repo = Join-Path $Workspace 'retroarch-netplay-bridge'
$artifacts = Join-Path $Workspace 'result\netplay-interop\mgba-multi-rom'
$work = Join-Path $env:LOCALAPPDATA 'RomMContinuationTest'
$runtime = Join-Path $work 'runtime'
$code = Join-Path $work 'repo'
foreach ($directory in @($work,$runtime,$code,(Join-Path $code 'test'),(Join-Path $code 'client'),(Join-Path $code 'node_modules'))) {
    New-Item -ItemType Directory -Force $directory | Out-Null
}
foreach ($name in @('server.mjs','native.mjs','native-launch.mjs','wire.mjs','admin.mjs','resources.mjs','save-extract.mjs','save-outbox.mjs','package.json')) {
    Copy-Item (Join-Path $repo $name) (Join-Path $code $name) -Force
}
Copy-Item (Join-Path $repo 'client\*.js') (Join-Path $code 'client') -Force
Copy-Item (Join-Path $repo 'client\windows-session.ps1') (Join-Path $code 'client') -Force
Copy-Item (Join-Path $repo 'test\windows-browser-peer.mjs') (Join-Path $code 'test') -Force
Copy-Item (Join-Path $repo 'test\windows-native-continuation.mjs') (Join-Path $code 'test') -Force
Copy-Item (Join-Path $repo 'test\windows-continuation-tunnel.ps1') (Join-Path $code 'test') -Force
if (-not (Test-Path (Join-Path $code 'node_modules\ws'))) {
    Copy-Item (Join-Path $repo 'node_modules\ws') (Join-Path $code 'node_modules') -Recurse
}
if (-not (Test-Path (Join-Path $runtime 'retroarch.exe'))) {
    Copy-Item (Join-Path $artifacts 'retroarch-win\RetroArch-Win64\*.dll') $runtime
    Copy-Item (Join-Path $artifacts 'retroarch-win\RetroArch-Win64\retroarch.exe') $runtime
}
Copy-Item (Join-Path $Workspace '.cache\romm-headless-browser\node-windows.exe') (Join-Path $work 'node.exe') -Force
Copy-Item (Join-Path $artifacts 'windows-bounded.exe') (Join-Path $work 'bounded.exe') -Force
if ($Scenario -in @('handoff', 'web-host', 'cable-browser')) {
    New-Item -ItemType Directory -Force (Join-Path $work 'web-build') | Out-Null
    Copy-Item (Join-Path $artifacts 'web-build\core-probe.mjs') (Join-Path $work 'web-build') -Force
    Copy-Item (Join-Path $artifacts 'web-build\core-probe.wasm') (Join-Path $work 'web-build') -Force
}
Copy-Item (Join-Path $Workspace 'romm-netplay-publish\custom-emulatorjs\data\cores\compat\rollback\mgba-spst4-multi\native\windows-x86_64\mgba_splitscreen_libretro.dll') (Join-Path $work 'core.dll') -Force
if ($Scenario -eq 'pacing') {
    Copy-Item (Join-Path $Workspace 'romm-netplay-publish\custom-emulatorjs\data\cores\compat\rollback\mgba-spst5\native\windows-x86_64\mgba_splitscreen_libretro.dll') (Join-Path $work 'core.dll') -Force
    Copy-Item (Join-Path $repo 'core-info\mgba_splitscreen_libretro.info') (Join-Path $work 'core.info') -Force
}
if ($Scenario -eq 'cable-browser') {
    $cable = Join-Path $Workspace 'result\netplay-interop\cable-20261107'
    Copy-Item (Join-Path $cable 'native-all\artifacts\mgba_splitscreen\windows-x86_64\mgba_splitscreen_libretro.dll') (Join-Path $work 'core.dll') -Force
    Copy-Item (Join-Path $cable 'mgba\core-probe.mjs') (Join-Path $work 'web-build') -Force
    Copy-Item (Join-Path $cable 'mgba\core-probe.wasm') (Join-Path $work 'web-build') -Force
}
foreach ($player in @(1,2)) {
    Copy-Item (Join-Path $repo "test\fixtures\gba-link-$player.gba") (Join-Path $work "player-$player.gba") -Force
}
if ($Content1) {
    Copy-Item -LiteralPath $Content1 -Destination (Join-Path $work 'player-1.gba') -Force
    Copy-Item -LiteralPath $Content2 -Destination (Join-Path $work 'player-2.gba') -Force
}
$arguments = @((Join-Path $work 'node.exe'), (Join-Path $code 'test\windows-native-continuation.mjs'), $work, $Scenario) |
    ForEach-Object { '"' + $_ + '"' }
if ($Diagnostic) { $arguments += '--diagnostic' }
if ($Content1) { $arguments += '--commercial' }
if ($Label) { $arguments += ('--label=' + $Label) }
$label = if ($Label) { $Label } else { $Scenario + $(if ($Diagnostic) { '-diagnostic' } else { '' }) }
$process = Start-Process -FilePath (Join-Path $work 'bounded.exe') -ArgumentList $arguments -WorkingDirectory $work -NoNewWindow -PassThru -Wait `
    -RedirectStandardOutput (Join-Path $work "$label.stdout.log") -RedirectStandardError (Join-Path $work "$label.stderr.log")
$output = Join-Path $Workspace "result\netplay-interop\native-continuation-20261104\$label"
New-Item -ItemType Directory -Force $output | Out-Null
Copy-Item (Join-Path $work "$label.*.log") $output -Force
if (Test-Path (Join-Path $work $label)) {
    Copy-Item (Join-Path $work "$label\*") $output -Recurse -Force
}
Write-Output "Bounded Windows test exit: $($process.ExitCode); evidence: $output"
Get-Content (Join-Path $work "$label.stdout.log")
Get-Content (Join-Path $work "$label.stderr.log")
exit $process.ExitCode
