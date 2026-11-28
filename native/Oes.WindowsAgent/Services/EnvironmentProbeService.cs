using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;
using Oes.WindowsAgent.Models;

namespace Oes.WindowsAgent.Services;

public sealed class EnvironmentProbeService
{
    private const int SmCMonitors = 80;
    private const int SmRemoteSession = 0x1000;

    private static readonly string[] SmbiosVmTokens =
    [
        "VMware",
        "VirtualBox",
        "VBOX",
        "QEMU",
        "KVM",
        "Xen",
        "Parallels",
        "Virtual Machine"
    ];

    private static readonly HashSet<string> RemoteControlProcessNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "teamviewer",
        "teamviewer_service",
        "anydesk",
        "ultraviewer",
        "ultraviewer_desktop",
        "ultraviewer_service",
        "rustdesk",
        "parsec",
        "parsecd",
        "ammyy",
        "vncviewer",
        "tvnserver",
        "radmin",
        "screenconnect.clientservice",
        "remoting_host",
        "mstsc"
    };

    private static readonly HashSet<string> VmProcessNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "vboxservice",
        "vboxtray",
        "vmtoolsd",
        "vmwaretray",
        "vmwareuser",
        "vmacthlp",
        "qemu-ga",
        "xenservice",
        "prl_tools"
    };

    private static readonly HashSet<string> DisallowedProcessNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "obs64",
        "obs32",
        "obs",
        "bandicam",
        "camtasia",
        "sharex",
        "snagit32",
        "snagiteditor",
        "greenshot",
        "lightshot",
        "discord",
        "zalo",
        "telegram",
        "whatsapp",
        "zoom",
        "chatgpt",
        "copilot",
        "claude",
        "vncserver"
    };

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    public AgentProbeResult Probe()
    {
        var vmIndicators = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        var remoteProcesses = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        var disallowedProcesses = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var process in Process.GetProcesses())
        {
            try
            {
                var name = process.ProcessName;
                if (string.IsNullOrWhiteSpace(name))
                {
                    continue;
                }

                if (VmProcessNames.Contains(name))
                {
                    vmIndicators.Add(name);
                }

                if (RemoteControlProcessNames.Contains(name))
                {
                    remoteProcesses.Add(name);
                }

                if (DisallowedProcessNames.Contains(name))
                {
                    disallowedProcesses.Add(name);
                }
            }
            catch
            {
                // Protected system processes may deny access under standard user privileges; skip safely.
            }
            finally
            {
                process.Dispose();
            }
        }

        if (IsRemoteDesktopSession())
        {
            remoteProcesses.Add("rdp-session");
        }

        foreach (var biosIndicator in DetectSmbiosVmIndicators())
        {
            vmIndicators.Add(biosIndicator);
        }

        return new AgentProbeResult(
            DeviceFingerprint: BuildDeviceFingerprint(),
            DisplayCount: DetectDisplayCount(),
            VmDetected: vmIndicators.Count > 0,
            VmIndicators: vmIndicators.ToArray(),
            RemoteControlDetected: remoteProcesses.Count > 0,
            RemoteControlProcesses: remoteProcesses.ToArray(),
            DisallowedProcesses: disallowedProcesses.ToArray(),
            ProbedAtUtc: DateTimeOffset.UtcNow
        );
    }

    private static bool IsRemoteDesktopSession()
    {
        if (!OperatingSystem.IsWindows())
        {
            return false;
        }

        try
        {
            return GetSystemMetrics(SmRemoteSession) != 0;
        }
        catch
        {
            return false;
        }
    }

    private static IReadOnlyList<string> DetectSmbiosVmIndicators()
    {
        if (!OperatingSystem.IsWindows())
        {
            return Array.Empty<string>();
        }

        try
        {
            using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
            using var biosKey = baseKey.OpenSubKey(@"HARDWARE\DESCRIPTION\System\BIOS", writable: false);
            if (biosKey is null)
            {
                return Array.Empty<string>();
            }

            var fields = new[]
            {
                biosKey.GetValue("SystemManufacturer")?.ToString(),
                biosKey.GetValue("SystemProductName")?.ToString()
            };

            var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var field in fields)
            {
                if (string.IsNullOrWhiteSpace(field))
                {
                    continue;
                }

                foreach (var token in SmbiosVmTokens)
                {
                    if (field.Contains(token, StringComparison.OrdinalIgnoreCase))
                    {
                        found.Add($"smbios:{token}");
                    }
                }
            }

            return found.ToArray();
        }
        catch
        {
            return Array.Empty<string>();
        }
    }

    private static int DetectDisplayCount()
    {
        if (!OperatingSystem.IsWindows())
        {
            return 1;
        }

        try
        {
            var count = GetSystemMetrics(SmCMonitors);
            return count > 0 ? count : 1;
        }
        catch
        {
            return 1;
        }
    }

    private static string ReadWindowsMachineGuid()
    {
        if (!OperatingSystem.IsWindows())
        {
            return string.Empty;
        }

        try
        {
            using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
            using var subKey = baseKey.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography", writable: false);
            var value = subKey?.GetValue("MachineGuid")?.ToString()?.Trim();
            return string.IsNullOrWhiteSpace(value) ? string.Empty : value;
        }
        catch
        {
            return string.Empty;
        }
    }

    private static string BuildDeviceFingerprint()
    {
        var machineGuid = ReadWindowsMachineGuid();
        var raw = string.Join("|",
            machineGuid,
            Environment.MachineName,
            Environment.UserDomainName,
            Environment.ProcessorCount.ToString(),
            RuntimeInformation.OSArchitecture.ToString(),
            OperatingSystem.IsWindows() ? "win" : "other");

        var hashBytes = SHA256.HashData(Encoding.UTF8.GetBytes(raw));
        var shortHex = Convert.ToHexString(hashBytes)[..32].ToLowerInvariant();
        return $"oes-win-{shortHex}";
    }
}
