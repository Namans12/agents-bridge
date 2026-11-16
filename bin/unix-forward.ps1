# Windows only. Node cannot listen on a Unix domain socket there (it makes named pipes),
# but Claude Code's $.http.fetch connects to a Unix socket path. This forwarder, started
# by the bridge daemon, listens on a real Unix socket and relays each connection to the
# daemon's named pipe.
#
#   pwsh -File unix-forward.ps1 <unix socket path> <pipe name>
#
# It exits when its stdin closes, which is when the daemon that started it exits.
param(
  [Parameter(Mandatory = $true)][string]$UnixPath,
  [Parameter(Mandatory = $true)][string]$PipeName
)

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Threading.Tasks;

public static class CodexUnixForward
{
    public static void Run(string unixPath, string pipeName)
    {
        var server = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        server.Bind(new UnixDomainSocketEndPoint(unixPath));
        server.Listen(64);
        // Node cannot stat a Unix socket file on Windows, so tell the bridge we listen with a plain file.
        File.WriteAllText(Path.Combine(Path.GetDirectoryName(unixPath), "forward.ready"), "1");

        // The daemon holds our stdin open; its end of the pipe closing means it is gone.
        Task.Run(() =>
        {
            var stdin = Console.OpenStandardInput();
            var buffer = new byte[256];
            while (stdin.Read(buffer, 0, buffer.Length) > 0) { }
            Environment.Exit(0);
        });

        while (true)
        {
            var client = server.Accept();
            Task.Run(() => Relay(client, pipeName));
        }
    }

    static async Task Relay(Socket client, string pipeName)
    {
        try
        {
            using (var socketStream = new NetworkStream(client, true))
            using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous))
            {
                await pipe.ConnectAsync(5000);
                var up = socketStream.CopyToAsync(pipe, 81920);
                var down = pipe.CopyToAsync(socketStream, 81920);
                await Task.WhenAny(up, down);
            }
        }
        catch (Exception) { }
    }
}
'@

[CodexUnixForward]::Run($UnixPath, $PipeName)
