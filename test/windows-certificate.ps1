param([string]$Launcher, [string]$Certificate)
$ErrorActionPreference = 'Stop'
. $Launcher -LibraryOnly
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
$root = Join-Path $env:TEMP ('RomMCertificateTest-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $root | Out-Null
$source = New-Object Security.Cryptography.X509Certificates.X509Certificate2($Certificate)
$file = Join-Path $root 'RomM-CA.cer'
try {
    [IO.File]::WriteAllBytes($file, $source.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    $session = [pscustomobject]@{ origin='https://192.168.3.100:8443'; certificate=[pscustomobject]@{name='RomM-CA.cer'; sha256=(Get-Sha256 $file)} }
    $parsed = Get-SessionCertificate $session $root
    try {
        Assert ($parsed.Thumbprint -eq $source.Thumbprint) 'Wrong certificate'
        Assert (-not $parsed.HasPrivateKey) 'Private key was loaded'
        Assert (Test-TrustedRoot $parsed) 'Read-only installer check requires the already trusted LAN test CA'
    } finally { $parsed.Dispose() }
    Install-SessionCertificate $session $root
    $session.certificate.sha256 = '0' * 64
    $rejected = $false
    try { Get-SessionCertificate $session $root | Out-Null } catch { $rejected = $_.Exception.Message -match 'checksum mismatch' }
    Assert $rejected 'Changed certificate accepted'
    $session.certificate.name = '..\different.cer'
    $rejected = $false
    try { Get-SessionCertificate $session $root | Out-Null } catch { $rejected = $_.Exception.Message -match 'Invalid certificate package' }
    Assert $rejected 'Certificate path traversal accepted'
    Write-Host 'Certificate package passed: public root parsing, checksum, path restriction and already-trusted installer; trust stores unchanged, no emulator launched.'
} finally { $source.Dispose(); Remove-Item -LiteralPath $root -Recurse -Force }
