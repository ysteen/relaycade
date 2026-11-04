param([string]$Launcher)
$ErrorActionPreference = 'Stop'
. $Launcher -LibraryOnly
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
$root = Join-Path $env:TEMP ('RomMSessionConfigTest-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root, (Join-Path $root 'cache') | Out-Null
try {
    $executable = Join-Path $root 'retroarch.exe'
    $writer = New-Object IO.BinaryWriter([IO.File]::Create($executable))
    try {
        $writer.Write([uint16]0x5a4d)
        $writer.BaseStream.Position = 0x3c
        $writer.Write([uint32]0x40)
        $writer.Write([uint32]0x4550)
        $writer.Write([uint16]0x8664)
    } finally { $writer.Dispose() }
    function Asset([string]$Name, [byte[]]$Data) {
        $path = Join-Path $root $Name
        [IO.File]::WriteAllBytes($path, $Data)
        $hash = Get-Sha256 $path
        [IO.File]::Copy($path, (Join-Path $root ('cache\' + $hash)))
        return [pscustomobject]@{ name = $Name; size = $Data.Length; sha256 = $hash; url = ('https://romm.example/' + $Name) }
    }
    function Receive-SessionFile { throw 'The config test must not download or launch anything' }
    $session = [pscustomobject]@{
        schemaVersion = 1; roomId = 'config-test'; platform = 'windows-x86_64'
        expiresAt = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 60000)
        credential = ('a' * 32); origin = 'https://romm.example'
        connection = [pscustomobject]@{ host = '127.0.0.1'; port = 1234; password = ('b' * 32); nickname = 'Test' }
        profile = [pscustomobject]@{ id = 'mgba_splitscreen'; subsystem = 'gba_link_2p'; options = [pscustomobject]@{} }
        core = (Asset 'mgba_splitscreen_libretro.dll' ([byte[]]@(1,2,3,4)))
        coreInfo = $null
        cartridges = @((Asset 'player-1.gba' ([byte[]]@(5,6))), (Asset 'player-2.gba' ([byte[]]@(7,8))))
    }
    $base = Join-Path $root 'retroarch.cfg'
    [IO.File]::WriteAllText($base, @'
pause_nonactive = "true"
menu_pause_libretro = "true"
config_save_on_exit = "true"
core_options_path = "existing-options.cfg"
input_player1_joypad_index = "2"
'@)
    $original = Get-Sha256 $base
    $launch = Initialize-NativeSession $session $executable $root
    $text = [IO.File]::ReadAllText((Join-Path $launch.Directory 'retroarch.cfg'))
    function FirstValue([string]$Key) { [regex]::Match($text, ('(?m)^\s*' + $Key + '\s*=\s*"([^"]*)"')).Groups[1].Value }
    foreach ($key in @('pause_nonactive', 'menu_pause_libretro', 'config_save_on_exit')) {
        Assert ((FirstValue $key) -eq 'false') "Inherited setting overrode the room setting: $key"
    }
    Assert ((FirstValue 'core_options_path') -ne 'existing-options.cfg') 'The session used another core options file'
    Assert ((FirstValue 'input_player1_joypad_index') -eq '2') 'Existing controls were lost'
    Assert ((Get-Sha256 $base) -eq $original) 'Existing RetroArch configuration changed'
    Assert (-not $text.Contains($session.connection.password)) 'Private room password leaked into configuration'
    $session.schemaVersion = 3
    $session.cartridges += @((Asset 'player-3.gba' ([byte[]]@(9,10))), (Asset 'player-4.gba' ([byte[]]@(11,12))))
    $session | Add-Member -NotePropertyName initialBatteries -NotePropertyValue @('AQID', 'BAUG', 'BwgJ', 'CgsM')
    foreach ($profile in @('mgba_splitscreen', 'sameboy', 'snes9x')) {
        $session.profile.id = $profile
        $session.core.name = $profile + '_libretro.dll'
        $session.profile.subsystem = switch ($profile) { 'mgba_splitscreen' { 'gba_link_4p' }; 'sameboy' { 'gb_link_2p' }; 'snes9x' { '' } }
        if ($profile -eq 'sameboy') {
            $session.cartridges = @($session.cartridges[0], $session.cartridges[1])
            $session.initialBatteries = @('AQID', 'BAUG')
        }
        if ($profile -eq 'snes9x') {
            $session.cartridges = @($session.cartridges[0])
            $session.initialBatteries = @('AQID')
        }
        $extension = switch ($profile) { 'mgba_splitscreen' { 'gba' }; 'sameboy' { 'gb' }; 'snes9x' { 'sfc' } }
        for ($slot = 0; $slot -lt $session.cartridges.Count; $slot++) { $session.cartridges[$slot].name = 'player-' + ($slot + 1) + '.' + $extension }
        $prepared = Initialize-NativeSession $session $executable $root
        $configText = [IO.File]::ReadAllText((Join-Path $prepared.Directory 'retroarch.cfg'))
        $configuredSaves = [regex]::Match($configText, '(?m)^savefile_directory = "([^"]+)"').Groups[1].Value
        Assert ($configuredSaves -eq (Join-Path $prepared.Directory 'saves').Replace('\', '/')) 'The client would append .netplay twice'
        for ($slot = 0; $slot -lt $session.cartridges.Count; $slot++) {
            $ext = if ($profile -eq 'mgba_splitscreen') { @('sav', 'sav2', 'sav3', 'sav4')[$slot] } else { 'srm' }
            $save = Join-Path $configuredSaves ('.netplay\player-' + ($slot + 1) + '.' + $ext)
            Assert ([IO.File]::Exists($save)) "Missing selected save: $profile slot $slot"
            Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($save)) -eq $session.initialBatteries[$slot]) 'Selected save changed'
        }
    }
    $session.initialBatteries = @('')
    $fresh = Initialize-NativeSession $session $executable $root
    Assert (@(Get-ChildItem (Join-Path $fresh.Directory 'saves') -File -Recurse -Force).Count -eq 0) 'Fresh start reused a previous save'
    foreach ($invalid in @(@(), @('!bad'), @('AQ==','Ag=='))) {
        $session.initialBatteries = $invalid
        $rejected = $false
        try { Assert-Session $session } catch { $rejected = $true }
        Assert $rejected 'Malformed save selection was accepted'
    }
    Write-Host 'Session configuration passed: room overrides, selected saves for all three cores, fresh save isolation, malformed save rejection; no emulator started.'
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
