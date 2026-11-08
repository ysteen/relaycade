param([Parameter(Mandatory)][string]$Launcher)
$ErrorActionPreference = 'Stop'
. $Launcher -LibraryOnly
$variable = 'ROMM_NETPLAY_PLAYER_FILE'
$original = [Environment]::GetEnvironmentVariable($variable, 'Process')
try {
    [Environment]::SetEnvironmentVariable($variable, 'parent-sentinel', 'Process')
    foreach ($view in @('C:\test session\player-view.txt', '')) {
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = Join-Path $PSHOME 'powershell.exe'
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.Arguments = '-NoProfile -Command "[Console]::Write([Environment]::GetEnvironmentVariable(''ROMM_NETPLAY_PLAYER_FILE'', ''Process''))"'
        $process = Start-NativeProcess $info $view
        try {
            if (-not $process.WaitForExit(5000)) { $process.Kill(); throw 'Child process timed out' }
            $actual = $process.StandardOutput.ReadToEnd()
            if ($process.ExitCode -ne 0 -or $actual -cne $view) { throw 'The child did not inherit its selected player view' }
            if ([Environment]::GetEnvironmentVariable($variable, 'Process') -cne 'parent-sentinel') { throw 'The launcher did not restore its environment' }
        } finally { $process.Dispose() }
    }
    $invalid = New-Object Diagnostics.ProcessStartInfo
    $invalid.FileName = Join-Path $env:TEMP ('missing-' + [Guid]::NewGuid().ToString('N') + '.exe')
    $invalid.UseShellExecute = $false
    $failed = $false
    try { Start-NativeProcess $invalid 'temporary-view' | Out-Null } catch { $failed = $true }
    if (-not $failed -or [Environment]::GetEnvironmentVariable($variable, 'Process') -cne 'parent-sentinel') { throw 'Failed startup leaked its player view' }
    Write-Host 'Child environment passed: selected view, empty view, parent restoration and startup failure; no emulator started.'
} finally { [Environment]::SetEnvironmentVariable($variable, $original, 'Process') }
