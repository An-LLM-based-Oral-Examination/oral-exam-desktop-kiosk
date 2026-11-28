using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;
using Oes.WindowsAgent.Services;

var serializerOptions = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    WriteIndented = false
};

var probeService = new EnvironmentProbeService();
var isWatchMode = args.Any(arg => string.Equals(arg, "--watch", StringComparison.OrdinalIgnoreCase));

if (!isWatchMode)
{
    var snapshot = probeService.Probe();
    Console.WriteLine(JsonSerializer.Serialize(snapshot, serializerOptions));
    return 0;
}

var intervalMs = 15_000;
var watchIndex = Array.FindIndex(args, arg => string.Equals(arg, "--watch", StringComparison.OrdinalIgnoreCase));
if (watchIndex >= 0 && watchIndex + 1 < args.Length && int.TryParse(args[watchIndex + 1], out var parsedInterval))
{
    intervalMs = Math.Clamp(parsedInterval, 2_000, 120_000);
}

int? parentPid = null;
var parentPidIndex = Array.FindIndex(args, arg => string.Equals(arg, "--parent-pid", StringComparison.OrdinalIgnoreCase));
if (parentPidIndex >= 0 && parentPidIndex + 1 < args.Length && int.TryParse(args[parentPidIndex + 1], out var parsedParentPid) && parsedParentPid > 0)
{
    parentPid = parsedParentPid;
}

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    cts.Cancel();
};

Process? parentProcess = null;
EventHandler? onParentExited = null;
if (parentPid is > 0)
{
    try
    {
        parentProcess = Process.GetProcessById(parentPid.Value);
        parentProcess.EnableRaisingEvents = true;
        onParentExited = (_, _) =>
        {
            try
            {
                cts.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // Shutdown already in progress.
            }
        };
        parentProcess.Exited += onParentExited;
        if (parentProcess.HasExited)
        {
            cts.Cancel();
        }
    }
    catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or Win32Exception)
    {
        cts.Cancel();
    }
}

using var parentProcessGuard = parentProcess;

static bool IsParentProcessExited(Process? process, int? expectedParentPid)
{
    if (expectedParentPid is not > 0)
    {
        return false;
    }

    if (process is null)
    {
        return true;
    }

    try
    {
        return process.HasExited;
    }
    catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
    {
        return true;
    }
}

try
{
    while (!cts.IsCancellationRequested && !IsParentProcessExited(parentProcessGuard, parentPid))
    {
        var snapshot = probeService.Probe();
        if (cts.IsCancellationRequested || IsParentProcessExited(parentProcessGuard, parentPid))
        {
            break;
        }

        Console.WriteLine(JsonSerializer.Serialize(snapshot, serializerOptions));

        try
        {
            await Console.Out.FlushAsync(cts.Token);
            await Task.Delay(intervalMs, cts.Token);
        }
        catch (OperationCanceledException)
        {
            break;
        }
    }
}
finally
{
    if (parentProcessGuard is not null && onParentExited is not null)
    {
        parentProcessGuard.Exited -= onParentExited;
    }
}

return 0;
