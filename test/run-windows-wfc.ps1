param([Parameter(Mandatory)][string]$Workspace, [ValidateSet('boot','menu','wfc','progress','controls')][string]$Mode = 'boot')
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$work = Join-Path $env:LOCALAPPDATA ('RomMWfcTest-' + [guid]::NewGuid().ToString('N'))
$evidence = Join-Path $Workspace ('result\wfc-qualification\' + $Mode)
New-Item -ItemType Directory -Force $work, $evidence, (Join-Path $work 'repo\test'), (Join-Path $work 'repo\node_modules') | Out-Null
$previous = @(Get-ChildItem -LiteralPath $evidence -File)
if ($previous.Count) {
    $history = Join-Path $evidence ('history\' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $history | Out-Null
    $previous | Move-Item -Destination $history
}
try {
    Copy-Item (Join-Path $Workspace 'result\netplay-interop\mgba-multi-rom\windows-bounded.exe') (Join-Path $work 'bounded.exe')
    Copy-Item (Join-Path $Workspace '.cache\romm-headless-browser\node-windows.exe') (Join-Path $work 'node.exe')
    Copy-Item (Join-Path $Workspace 'romm\test-instance\link-test-account.json') (Join-Path $work 'account.json')
    Copy-Item (Join-Path $Workspace 'result\wfc-qualification\pokemon.nds') $work
    $save = Join-Path $Workspace 'result\wfc-qualification\user-save.srm'
    if (Test-Path $save) { Copy-Item $save $work }
    Copy-Item (Join-Path $Workspace 'build\melonds-ds-package\web\melondsds-wasm.data') $work
    Copy-Item (Join-Path $Workspace 'build\melonds-ds-package\web\build.json') (Join-Path $work 'melondsds.json')
    if ($Mode -in @('progress','wfc')) {
        Copy-Item (Join-Path $Workspace 'result\wfc-qualification\scenario.json') $work
    }
    if ($Mode -eq 'progress') {
        $checkpoint = Join-Path $Workspace 'result\wfc-qualification\user-save.state'
        if (Test-Path $checkpoint) { Copy-Item $checkpoint (Join-Path $work 'checkpoint.state') }
    }
    if ($Mode -eq 'controls') {
        Copy-Item (Join-Path $Workspace 'result\wfc-qualification\wifi-ready.state') (Join-Path $work 'checkpoint.state')
    }
    foreach ($name in @('windows-browser-peer.mjs','windows-wfc-browser.mjs','windows-wfc-controls.mjs')) {
        Copy-Item (Join-Path $repository ('test\' + $name)) (Join-Path $work 'repo\test')
    }
    Copy-Item (Join-Path $Workspace 'retroarch-netplay-bridge\node_modules\ws') (Join-Path $work 'repo\node_modules') -Recurse
    $arguments = @((Join-Path $work 'node.exe'), (Join-Path $work 'repo\test\windows-wfc-browser.mjs'), $work, $Mode) | ForEach-Object { '"' + $_ + '"' }
    $process = Start-Process -FilePath (Join-Path $work 'bounded.exe') -ArgumentList $arguments -WorkingDirectory $work -NoNewWindow -PassThru -Wait -RedirectStandardOutput (Join-Path $work 'stdout.log') -RedirectStandardError (Join-Path $work 'stderr.log')
    Copy-Item (Join-Path $work '*.log') $evidence -Force
    if (Test-Path (Join-Path $work 'evidence')) { Copy-Item (Join-Path $work 'evidence\*') $evidence -Force }
    if (Test-Path (Join-Path $work 'evidence\checkpoint.state')) { Copy-Item (Join-Path $work 'evidence\checkpoint.state') (Join-Path $Workspace 'result\wfc-qualification\user-save.state') -Force }
    Get-Content (Join-Path $work 'stdout.log')
    if ($process.ExitCode -ne 0) { Get-Content (Join-Path $work 'stderr.log') -Tail 10 }
    exit $process.ExitCode
} finally { Remove-Item -LiteralPath $work -Recurse -Force }
