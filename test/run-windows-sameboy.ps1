param(
    [Parameter(Mandatory)][string]$Workspace,
    [Parameter(Mandatory)][string]$Content1,
    [Parameter(Mandatory)][string]$Content2,
    [ValidateSet('view','launch','save-sync')][string]$Mode = 'launch',
    [ValidatePattern('^[a-z0-9-]+$')][string]$Label = '',
    [ValidateSet('sameboy','mgba_splitscreen','snes9x')][string]$Core = 'sameboy',
    [switch]$CheckpointLag,
    [switch]$StartupHeartbeat
)
$ErrorActionPreference = 'Stop'
$repo = Join-Path $Workspace 'retroarch-netplay-bridge'
$artifacts = Join-Path $Workspace 'result\netplay-interop\sameboy-player-view-20261107'
$work = Join-Path $env:LOCALAPPDATA ('RomMSameBoyTest-' + [Guid]::NewGuid().ToString('N'))
$evidence = Join-Path $artifacts $(if ($Label) { $Label } else { $Mode })
New-Item -ItemType Directory -Force $work, $evidence | Out-Null
try {
    Copy-Item (Join-Path $Workspace 'result\netplay-interop\mgba-multi-rom\windows-bounded.exe') (Join-Path $work 'bounded.exe')
    $profile = switch ($Core) {
        'sameboy' { @{ Extension = 'gb'; Path = 'sameboy-sbr3' } }
        'mgba_splitscreen' { @{ Extension = 'gba'; Path = 'mgba-spst5' } }
        'snes9x' { @{ Extension = 'sfc'; Path = 'snes9x-2d4cce69' } }
    }
    $coreRoot = Join-Path $Workspace ('romm-netplay-publish\custom-emulatorjs\data\cores\compat\rollback\' + $profile.Path + '\native\windows-x86_64')
    Copy-Item (Join-Path $coreRoot ($Core + '_libretro.dll')) $work
    if ($Core -ne 'snes9x') { Copy-Item (Join-Path $repo ('core-info\' + $Core + '_libretro.info')) $work }
    Copy-Item -LiteralPath $Content1 -Destination (Join-Path $work ('player-1.' + $profile.Extension))
    Copy-Item -LiteralPath $Content2 -Destination (Join-Path $work ('player-2.' + $profile.Extension))
    if ($Mode -eq 'view') {
        if ($Core -ne 'sameboy') { throw 'The display probe only supports SameBoy.' }
        Copy-Item (Join-Path $artifacts 'sameboy-player-view.exe') (Join-Path $work 'probe.exe')
        $command = @((Join-Path $work 'probe.exe'), (Join-Path $work 'sameboy_libretro.dll'), (Join-Path $work 'player-1.gb'), (Join-Path $work 'player-2.gb'), (Join-Path $work 'player.txt'))
    } else {
        $code = Join-Path $work 'repo'
        $runtime = Join-Path $work 'runtime'
        New-Item -ItemType Directory -Force $code, $runtime, (Join-Path $code 'client'), (Join-Path $code 'test'), (Join-Path $code 'node_modules') | Out-Null
        foreach ($name in @('server.mjs','native.mjs','native-launch.mjs','wire.mjs','admin.mjs','resources.mjs','save-extract.mjs','save-outbox.mjs','package.json')) {
            Copy-Item (Join-Path $repo $name) $code
        }
        Copy-Item (Join-Path $repo 'client\*.js') (Join-Path $code 'client')
        Copy-Item (Join-Path $repo 'client\windows-session.ps1') (Join-Path $code 'client')
        Copy-Item (Join-Path $repo 'test\windows-sameboy-launch.mjs') (Join-Path $code 'test')
        Copy-Item (Join-Path $repo 'node_modules\ws') (Join-Path $code 'node_modules') -Recurse
        Copy-Item (Join-Path $env:LOCALAPPDATA 'RomMContinuationTest\runtime\*.dll') $runtime
        Copy-Item (Join-Path $env:LOCALAPPDATA 'RomMContinuationTest\runtime\retroarch.exe') $runtime
        @'
video_driver = "gl"
audio_driver = "null"
video_window_scale = "1"
video_vsync = "false"
vrr_runloop_enable = "true"
fastforward_ratio = "1.0"
libretro_log_level = "2"
'@ | Set-Content (Join-Path $runtime 'retroarch.cfg') -Encoding ASCII
        Copy-Item (Join-Path $Workspace '.cache\romm-headless-browser\node-windows.exe') (Join-Path $work 'node.exe')
        $command = @((Join-Path $work 'node.exe'), (Join-Path $code 'test\windows-sameboy-launch.mjs'), $work)
        $command += ('--core=' + $Core)
        if ($Mode -eq 'save-sync') { $command += '--save-sync' }
        if ($CheckpointLag) { $command += '--checkpoint-lag' }
        if ($StartupHeartbeat) { $command += '--startup-heartbeat' }
    }
    $arguments = $command | ForEach-Object { '"' + $_ + '"' }
    $process = Start-Process -FilePath (Join-Path $work 'bounded.exe') -ArgumentList $arguments -WorkingDirectory $work -NoNewWindow -PassThru -Wait `
        -RedirectStandardOutput (Join-Path $work 'stdout.log') -RedirectStandardError (Join-Path $work 'stderr.log')
    Copy-Item (Join-Path $work '*.log') $evidence -Force
    if (Test-Path (Join-Path $work 'evidence')) {
        Copy-Item (Join-Path $work 'evidence\*') $evidence -Recurse -Force
        Get-ChildItem $evidence -Recurse -File -Filter 'session.json' | Remove-Item -Force
    }
    Write-Output "Bounded $Core $Mode test exit: $($process.ExitCode)"
    Get-Content (Join-Path $work 'stdout.log') | Select-String '^\{'
    if ($process.ExitCode -ne 0) { Get-Content (Join-Path $work 'stderr.log') -Tail 15 }
    exit $process.ExitCode
} finally { Remove-Item -LiteralPath $work -Recurse -Force }
