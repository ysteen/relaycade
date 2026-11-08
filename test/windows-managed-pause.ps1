param([Parameter(Mandatory)][string]$Launcher)
$ErrorActionPreference = 'Stop'
. $Launcher -LibraryOnly
Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading.Tasks;
public sealed class PauseFixture : IDisposable {
    readonly UdpClient socket = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
    volatile bool running = true;
    public volatile bool Paused;
    public int Toggles;
    public int Port { get { return ((IPEndPoint)socket.Client.LocalEndPoint).Port; } }
    public PauseFixture() {
        Task.Run(() => {
            while (running) {
                try {
                    var source = new IPEndPoint(IPAddress.Any, 0);
                    var text = Encoding.ASCII.GetString(socket.Receive(ref source));
                    if (text == "GET_STATUS\n") {
                        var reply = Encoding.ASCII.GetBytes("GET_STATUS " + (Paused ? "PAUSED" : "PLAYING") + " fixture\n");
                        socket.Send(reply, reply.Length, source);
                    } else if (text == "PAUSE_TOGGLE\n") {
                        if (System.Threading.Interlocked.Increment(ref Toggles) > 1) Paused = !Paused;
                    }
                } catch (SocketException) { if (!running) return; }
                catch (ObjectDisposedException) { return; }
            }
        });
    }
    public void Dispose() { running = false; socket.Close(); }
}
'@
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Wait-For([scriptblock]$Condition) {
    $deadline = [DateTime]::UtcNow.AddSeconds(4)
    while (-not (& $Condition)) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Pause acknowledgement timed out' }
        Start-Sleep -Milliseconds 20
    }
}
$fixture = New-Object PauseFixture
$tunnel = Start-NativeTunnel ([pscustomobject]@{host='127.0.0.1';port=1;password='test-only'}) ''
try {
    $tunnel.AttachControl($fixture.Port)
    $method = $tunnel.GetType().GetMethod('SetPause', [Reflection.BindingFlags]'NonPublic,Instance')
    $echo = $tunnel.GetType().GetMethod('PauseEcho', [Reflection.BindingFlags]'NonPublic,Instance')
    $confirm = $tunnel.GetType().GetMethod('ConfirmPause', [Reflection.BindingFlags]'NonPublic,Instance')
    $confirm.Invoke($tunnel, @($true)).GetAwaiter().GetResult() | Out-Null
    Assert ($fixture.Paused) 'Pause confirmation resolved before the state changed'
    Start-Sleep -Milliseconds 250
    Assert ($fixture.Toggles -ge 2) 'The lost command was not retried'
    Assert ($echo.Invoke($tunnel, @([uint32]0x43))) 'Managed pause echo escaped'
    $count = $fixture.Toggles
    foreach ($unused in 1..2) { $method.Invoke($tunnel, @($true)) | Out-Null }
    Start-Sleep -Milliseconds 250
    Assert ($fixture.Toggles -eq $count) 'Duplicate pause requests unpaused the client'
    $confirm.Invoke($tunnel, @($false)).GetAwaiter().GetResult() | Out-Null
    Assert (-not $fixture.Paused) 'Resume confirmation resolved before the state changed'
    Start-Sleep -Milliseconds 250
    Assert ($echo.Invoke($tunnel, @([uint32]0x44))) 'Managed resume echo escaped'
    Assert (-not $echo.Invoke($tunnel, @([uint32]0x43))) 'A user pause was suppressed'
    $method.Invoke($tunnel, @($true)) | Out-Null
    $method.Invoke($tunnel, @($false)) | Out-Null
    Start-Sleep -Milliseconds 400
    Assert (-not $fixture.Paused) 'A superseded pause request remained applied'
    Assert (-not $tunnel.Error) $tunnel.Error
    Write-Host 'Managed pause passed: confirmed state, lost-command retry, duplicates, echo suppression and superseded requests; no emulator started.'
} finally { $tunnel.Dispose(); $fixture.Dispose() }
