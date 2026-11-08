param(
    [Parameter(Mandatory)][string]$Workspace,
    [Parameter(Mandatory)][string]$Content1,
    [Parameter(Mandatory)][string]$Content2
)
$ErrorActionPreference = 'Stop'
$artifacts = Join-Path $Workspace 'result\netplay-interop\commercial-20261107'
$work = Join-Path $env:LOCALAPPDATA ('RomMCommercialSameBoy-' + [Guid]::NewGuid().ToString('N'))
$evidence = Join-Path $artifacts 'sameboy-gold-silver'
New-Item -ItemType Directory -Force $work, $evidence | Out-Null
try {
    Copy-Item (Join-Path $Workspace 'result\netplay-interop\mgba-multi-rom\windows-bounded.exe') (Join-Path $work 'bounded.exe')
    Copy-Item (Join-Path $artifacts 'sameboy-pair-probe.exe') (Join-Path $work 'probe.exe')
    Copy-Item (Join-Path $Workspace 'romm-netplay-publish\custom-emulatorjs\data\cores\compat\rollback\sameboy-sbr3\native\windows-x86_64\sameboy_libretro.dll') (Join-Path $work 'core.dll')
    Copy-Item -LiteralPath $Content1 -Destination (Join-Path $work 'first.gbc')
    Copy-Item -LiteralPath $Content2 -Destination (Join-Path $work 'second.gbc')
    $arguments = @((Join-Path $work 'probe.exe'), (Join-Path $work 'core.dll'), (Join-Path $work 'first.gbc'), 'cable', (Join-Path $work 'state'), (Join-Path $work 'second.gbc')) |
        ForEach-Object { '"' + $_ + '"' }
    $process = Start-Process -FilePath (Join-Path $work 'bounded.exe') -ArgumentList $arguments -WorkingDirectory $work -NoNewWindow -PassThru -Wait `
        -RedirectStandardOutput (Join-Path $work 'stdout.log') -RedirectStandardError (Join-Path $work 'stderr.log')
    Copy-Item (Join-Path $work '*.log') $evidence -Force
    Copy-Item (Join-Path $work 'state-*.bin') $evidence -Force
    Write-Output "Bounded SameBoy distinct-cartridge test exit: $($process.ExitCode)"
    Get-Content (Join-Path $work 'stdout.log') | Select-String '^\{'
    if ($process.ExitCode -ne 0) { Get-Content (Join-Path $work 'stderr.log') -Tail 12 }
    exit $process.ExitCode
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force
}
