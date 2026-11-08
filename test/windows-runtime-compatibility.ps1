param([string]$Launcher, [string]$Legacy, [string]$Modern)
$ErrorActionPreference = 'Stop'
. $Launcher -LibraryOnly
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }

if ($Legacy) { Assert ((Get-RetroArchVersion $Legacy) -lt [Version]'1.22.2') 'Legacy runtime was not identified' }
if ($Modern) { Assert ((Get-RetroArchVersion $Modern) -ge [Version]'1.22.2') 'Compatible runtime was not identified' }

$root = Join-Path $env:LOCALAPPDATA ('RomMRuntimeCompatibility-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $root | Out-Null
$originalCandidates = (Get-Item Function:Get-RetroArchCandidates).ScriptBlock
$originalVersion = (Get-Item Function:Get-RetroArchVersion).ScriptBlock
$originalPortable = (Get-Item Function:Initialize-PortableRetroArch).ScriptBlock
try {
    $old = Join-Path $root 'old.exe'
    $current = Join-Path $root 'current.exe'
    $unknown = Join-Path $root 'unknown.exe'
    foreach ($path in @($old, $current, $unknown)) {
        $bytes = New-Object byte[] 70
        [BitConverter]::GetBytes([uint16]0x5a4d).CopyTo($bytes, 0)
        [BitConverter]::GetBytes([uint32]64).CopyTo($bytes, 60)
        [BitConverter]::GetBytes([uint32]0x4550).CopyTo($bytes, 64)
        [BitConverter]::GetBytes([uint16]0x8664).CopyTo($bytes, 68)
        [IO.File]::WriteAllBytes($path, $bytes)
    }
    $script:versionProbes = 0
    function Get-RetroArchVersion([string]$Executable) {
        $script:versionProbes++
        if ($Executable -eq $old) { return [Version]'1.21.0' }
        if ($Executable -eq $current) { return [Version]'1.22.2' }
        throw 'Unrecognized version'
    }
    $script:portableDownloads = 0
    function Initialize-PortableRetroArch { $script:portableDownloads++; return 'portable-runtime' }
    $minimum = Get-MinimumRetroArchVersion ([PSCustomObject]@{profile = @{id = 'sameboy'}})
    Assert ($minimum -eq [Version]'1.22.2') 'SameBoy did not require a compatible frontend'
    function Get-RetroArchCandidates { @($current) }
    Assert ((Resolve-RetroArch '' $root 'windows-x86_64' $root $minimum) -eq $current) 'Compatible installation was not reused'
    Assert ((Resolve-RetroArch $current $root 'windows-x86_64' $root $minimum) -eq $current) 'Compatible explicit runtime was not reused'
    $rejected = $false
    try { Resolve-RetroArch $old $root 'windows-x86_64' $root $minimum } catch { $rejected = $_.Exception.Message -match 'Update RetroArch to 1.22.2' }
    Assert $rejected 'Explicit legacy runtime was accepted'
    function Get-RetroArchCandidates { @($old) }
    $rejected = $false
    try { Resolve-RetroArch '' $root 'windows-x86_64' $root $minimum } catch { $rejected = $_.Exception.Message -match 'Update RetroArch to 1.22.2' }
    Assert $rejected 'Discovered legacy installation did not show update instructions'
    function Get-RetroArchCandidates { @($unknown) }
    $rejected = $false
    try { Resolve-RetroArch '' $root 'windows-x86_64' $root $minimum } catch { $rejected = $_.Exception.Message -match 'Could not check the installed RetroArch version' }
    Assert $rejected 'Unknown installed version did not stop preparation'
    Assert ($script:portableDownloads -eq 0) 'Downloaded a runtime despite an existing installation'
    function Get-RetroArchCandidates { @() }
    Assert ((Resolve-RetroArch '' $root 'windows-x86_64' $root $minimum) -eq 'portable-runtime') 'Missing installation did not download a portable runtime'
    Assert ($script:portableDownloads -eq 1) 'Portable runtime was not prepared exactly once'
    function Get-RetroArchCandidates { @($old) }
    foreach ($core in @('mgba_splitscreen', 'snes9x')) {
        $unrestricted = Get-MinimumRetroArchVersion ([PSCustomObject]@{profile = @{id = $core}})
        $before = $script:versionProbes
        Assert ($null -eq $unrestricted) 'Unrelated core acquired a version restriction'
        Assert ((Resolve-RetroArch '' $root 'windows-x86_64' $root $unrestricted) -eq $old) 'Existing runtime selection changed for an unrelated core'
        Assert ($script:versionProbes -eq $before) 'Unrelated core ran a version probe'
    }
    Write-Host 'Runtime compatibility passed: actual versions, installed preference, explicit override, portable fallback, and unrelated cores.'
} finally {
    Set-Item Function:Get-RetroArchCandidates $originalCandidates
    Set-Item Function:Get-RetroArchVersion $originalVersion
    Set-Item Function:Initialize-PortableRetroArch $originalPortable
    Remove-Item -LiteralPath $root -Recurse -Force
}
