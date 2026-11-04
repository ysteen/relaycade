param([string]$Launcher, [string]$Archive, [string]$Output)
$ErrorActionPreference = 'Stop'
. $Launcher -LibraryOnly

function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Write-TestExecutable([string]$Path, [uint16]$Machine) {
    $stream = [IO.File]::Create($Path)
    $writer = New-Object IO.BinaryWriter($stream)
    try {
        $writer.Write([uint16]0x5a4d)
        $stream.Position = 0x3c
        $writer.Write([uint32]0x40)
        $writer.Write([uint32]0x4550)
        $writer.Write($Machine)
    } finally { $writer.Dispose(); $stream.Dispose() }
}

$root = Join-Path $env:LOCALAPPDATA ('RomMPortableTest-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $root | Out-Null
$downloadFunction = (Get-Item Function:Initialize-PortableRetroArch).ScriptBlock
$candidatesFunction = (Get-Item Function:Get-RetroArchCandidates).ScriptBlock
try {
    $found = @(Get-RetroArchCandidates $root $root | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) })
    $existing = Join-Path $root 'existing.exe'
    $explicit = Join-Path $root 'explicit.exe'
    $wrong = Join-Path $root 'wrong.exe'
    Write-TestExecutable $existing 0x8664
    Write-TestExecutable $explicit 0x8664
    Write-TestExecutable $wrong 0x014c
    [IO.File]::WriteAllText((Join-Path $root 'retroarch-path.txt'), $existing)
    function Initialize-PortableRetroArch { throw 'Downloaded despite an existing compatible RetroArch' }
    Assert ((Resolve-RetroArch '' $root 'windows-x86_64' $root) -eq $existing) 'Remembered RetroArch was not reused'
    Assert ((Resolve-RetroArch $explicit $root 'windows-x86_64' $root) -eq $explicit) 'Explicit path did not take precedence'
    $rejected = $false
    try { Resolve-RetroArch $wrong $root 'windows-x86_64' $root } catch { $rejected = $true }
    Assert $rejected 'Explicit incompatible ABI accepted'
    function Get-RetroArchCandidates { @('Z:\missing-retroarch.exe', $wrong, $existing) }
    Assert ((Find-InstalledRetroArch $root 'windows-x86_64' $root) -eq $existing) 'Discovery did not skip missing/incompatible executables'
    function Get-RetroArchCandidates { @('Z:\missing-retroarch.exe', $wrong) }
    function Initialize-PortableRetroArch { return 'portable-fallback' }
    Assert ((Resolve-RetroArch '' $root 'windows-x86_64' $root) -eq 'portable-fallback') 'Missing compatible executable did not use fallback'
    Set-Item Function:Get-RetroArchCandidates $candidatesFunction
    Set-Item Function:Initialize-PortableRetroArch $downloadFunction

    $build = Get-PortableBuild 'windows-x86_64'
    Assert ((Get-Sha256 $Archive) -eq $build.Sha256) 'Test archive does not match pinned official release'
    $runtimes = Join-Path $root 'runtimes'
    New-Item -ItemType Directory $runtimes | Out-Null
    [IO.File]::Copy($Archive, (Join-Path $runtimes ($build.Sha256 + '.7z')))
    $portable = Initialize-PortableRetroArch $root 'windows-x86_64'
    Assert ((Get-ExecutablePlatform $portable) -eq 'windows-x86_64') 'Portable executable has wrong ABI'
    Assert ((Get-Sha256 $portable) -eq '81c11b6f24932bf7918f05eee8928035bff3887335fd2a081507c75e9d94d06a') 'Extracted executable does not match official binary'
    Assert ((Initialize-PortableRetroArch $root 'windows-x86_64') -eq $portable) 'Portable cache not reused'
    @{ installedFirst = $true; explicitOverride = $true; architectureChecked = $true
        portableExtracted = $true; cacheReused = $true; existingCandidates = $found.Count; emulatorStarted = $false
    } | ConvertTo-Json | Set-Content -LiteralPath $Output -Encoding UTF8
    Write-Host 'Windows checks passed: installed first, explicit path, ABI filtering, portable extraction and cache reuse. No emulator started.'
} finally {
    Set-Item Function:Get-RetroArchCandidates $candidatesFunction
    Set-Item Function:Initialize-PortableRetroArch $downloadFunction
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Continue
}
