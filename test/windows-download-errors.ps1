param([string]$Launcher)
$ErrorActionPreference = 'Stop'
. $Launcher -LibraryOnly
Add-Type -AssemblyName System.Net.Http
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
$secret = 'test-private-launch-credential'
$url = 'https://user:password@romm.example/native/manifest?token=private-query#private-fragment'
foreach ($case in @(
    @{status='TrustFailure'; expected='Current User > Trusted Root Certification Authorities'},
    @{status='SecureChannelFailure'; expected='HTTPS handshake failed'},
    @{status='NameResolutionFailure'; expected='resolve the server name'},
    @{status='ProxyNameResolutionFailure'; expected='configured proxy'},
    @{status='ConnectFailure'; expected='connect to the server'},
    @{status='Timeout'; expected='timed out'}
)) {
    $inner = New-Object Net.WebException("Root cause $secret at $url", $null, [Net.WebExceptionStatus]$case.status, $null)
    $failure = New-Object Net.Http.HttpRequestException('An error occurred while sending the request.', $inner)
    $task = [Threading.Tasks.Task]::FromException($failure)
    $message = ''
    try { $task.GetAwaiter().GetResult() } catch { $message = Get-DownloadError $_.Exception $url $secret }
    Assert ($message.Contains($case.expected)) ('Missing actionable error for ' + $case.status)
    Assert ($message.Contains('Root cause')) 'Inner exception was hidden'
    Assert ($message.Contains('https://romm.example/native/manifest')) 'Missing safe endpoint'
    Assert (-not $message.Contains('GetResult')) 'PowerShell wrapper was retained'
    foreach ($value in @($secret, 'password', 'private-query', 'private-fragment')) {
        Assert (-not $message.Contains($value)) 'Private data was included in the error'
    }
}
$cancelled = New-Object Threading.Tasks.TaskCanceledException('Cancelled')
Assert ((Get-DownloadError $cancelled 'https://romm.example/' '').Contains('timed out')) 'Task cancellation was hidden'
foreach ($case in @(
    @{status=404; body='{"detail":"The room has closed. Refresh the room list and join a new room."}'; type='application/json'; expected='room has closed'},
    @{status=404; body='{"detail":"This Windows session preparation is no longer available."}'; type='application/json'; expected='preparation is no longer available'},
    @{status=410; body='{}'; type='application/json'; expected='preparation expired'},
    @{status=403; body='{}'; type='application/json'; expected='no longer authorized'},
    @{status=404; body='<html>private-upstream-details</html>'; type='text/html'; expected='room or download is no longer available'},
    @{status=404; body='{"detail":{"secret":"private-upstream-details"}}'; type='application/json'; expected='room or download is no longer available'},
    @{status=404; body=('x' * 4097); type='application/json'; expected='room or download is no longer available'}
)) {
    $response = New-Object Net.Http.HttpResponseMessage([Net.HttpStatusCode]$case.status)
    try {
        $response.Content = New-Object Net.Http.StringContent($case.body, [Text.Encoding]::UTF8, $case.type)
        $detail = Get-HttpDownloadError $response
        Assert ($detail -is [string]) 'HTTP error returned extra pipeline output'
        $message = Get-DownloadError (New-Object Exception($detail)) $url $secret
        Assert ($message.Contains($case.expected)) 'HTTP error lost its server reason'
        Assert ($message.Contains("HTTP $($case.status):")) 'HTTP status was hidden'
        Assert (-not $message.Contains('private-upstream-details')) 'Raw upstream error leaked'
        Assert (-not $message.Contains('if it expired')) 'Every HTTP error was attributed to expiry'
    } finally { $response.Dispose() }
}
Write-Host 'Download errors passed: GetResult wrapping, TLS, DNS, proxy, connection, timeout, HTTP room closure and expiry, bounded error bodies and redaction; no emulator launched.'
