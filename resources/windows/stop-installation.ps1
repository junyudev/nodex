param(
    [Parameter(Mandatory = $true)][string]$InstallationDirectory,
    [Parameter(Mandatory = $true)][string]$CoreHelper,
    [Parameter(Mandatory = $true)][int]$InstallerPid
)
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $InstallationDirectory -PathType Container)) { exit 0 }

# Native argument parsing handles quoted spaces, Unicode and trailing backslashes.
# Forced termination holds one process handle across the image check and kill,
# so PID reuse cannot redirect termination to another installation.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class NodexMaintenance {
    [DllImport("shell32.dll", SetLastError = true)]
    static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string text, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr process, uint timeout);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder path, uint size, uint flags);
    static string CanonicalPath(string path) {
        var file = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (file == new IntPtr(-1)) return null;
        try {
            var result = new StringBuilder(32768);
            uint size = GetFinalPathNameByHandleW(file, result, (uint)result.Capacity, 0);
            if (size == 0 || size >= result.Capacity) return null;
            var value = result.ToString();
            if (value.StartsWith(@"\\?\UNC\")) return @"\\" + value.Substring(8);
            return value.StartsWith(@"\\?\") ? value.Substring(4) : value;
        } finally { CloseHandle(file); }
    }
    public static string InstallationRoot(string path) {
        var canonical = CanonicalPath(path);
        if (canonical == null) throw new Win32Exception();
        return canonical.TrimEnd('\\') + @"\";
    }
    public static bool Contains(string root, string path) {
        var canonical = CanonicalPath(path);
        if (canonical != null) return canonical.StartsWith(root, StringComparison.OrdinalIgnoreCase);
        if (path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new Win32Exception();
        return false;
    }
    public static string[] Arguments(string commandLine) {
        int count;
        var memory = CommandLineToArgvW(commandLine, out count);
        if (memory == IntPtr.Zero) throw new Win32Exception();
        try {
            var result = new string[count];
            for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
            return result;
        } finally { LocalFree(memory); }
    }
    public static void Stop(uint pid, string root) {
        var process = OpenProcess(0x1000 | 0x0001 | 0x00100000, false, pid);
        if (process == IntPtr.Zero) {
            if (Marshal.GetLastWin32Error() == 87) return; // already exited
            throw new Win32Exception();
        }
        try {
            if (WaitForSingleObject(process, 0) == 0) return;
            var path = new StringBuilder(32768);
            int size = path.Capacity;
            if (!QueryFullProcessImageNameW(process, 0, path, ref size)) throw new Win32Exception();
            if (!Contains(root, path.ToString())) return;
            if (!TerminateProcess(process, 0)) throw new Win32Exception();
            if (WaitForSingleObject(process, 2000) != 0) throw new TimeoutException("Installation process did not stop");
        } finally { CloseHandle(process); }
    }
}
'@
$root = [NodexMaintenance]::InstallationRoot($InstallationDirectory)
if ([IO.Path]::GetPathRoot($root) -eq $root) { throw 'Refusing a drive root as an installation' }

function Get-InstallationProcesses {
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $InstallerPid -and $_.ExecutablePath -and
        [NodexMaintenance]::Contains($root, $_.ExecutablePath)
    })
}

# Let the desktop release its supervised runtimes before draining detached Core.
$desktop = @(Get-InstallationProcesses | Where-Object { $_.Name -ieq 'Nodex.exe' })
foreach ($image in $desktop) {
    $process = Get-Process -Id $image.ProcessId -ErrorAction SilentlyContinue
    if ($process) { [void]$process.CloseMainWindow(); $process.Dispose() }
}
if ($desktop.Count) { Start-Sleep -Milliseconds 1500 }
foreach ($image in (Get-InstallationProcesses | Where-Object { $_.Name -ieq 'Nodex.exe' })) {
    [NodexMaintenance]::Stop($image.ProcessId, $root)
}

$helpers = @()
try {
    foreach ($image in (Get-InstallationProcesses | Where-Object { $_.Name -ieq 'nodex-core.exe' })) {
        $arguments = [NodexMaintenance]::Arguments($image.CommandLine)
        $homeIndex = [Array]::IndexOf($arguments, '--home')
        if ($homeIndex -lt 0 -or $homeIndex + 1 -ge $arguments.Count) { continue }
        $coreHome = $arguments[$homeIndex + 1]
        # Windows paths cannot contain quotes; double trailing slashes before a closing quote.
        $quotedHome = '"' + [regex]::Replace($coreHome, '(\\+)$', '$1$1') + '"'
        $start = New-Object Diagnostics.ProcessStartInfo
        $start.FileName = $CoreHelper
        $start.Arguments = '--shutdown --home ' + $quotedHome + ' --expected-pid ' + $image.ProcessId
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $helpers += [Diagnostics.Process]::Start($start)
    }
    $graceDeadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        $cores = @(Get-InstallationProcesses | Where-Object { $_.Name -ieq 'nodex-core.exe' })
        if (!$cores.Count) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $graceDeadline)
} finally {
    foreach ($helper in $helpers) {
        if (!$helper.HasExited) { $helper.Kill(); [void]$helper.WaitForExit(2000) }
        $helper.Dispose()
    }
}

# Include CLI, standalone Node, Agent and search executables, without name-wide kills
# or following children into another installation or a system runtime.
$forceDeadline = [DateTime]::UtcNow.AddSeconds(5)
do {
    $remaining = @(Get-InstallationProcesses)
    if (!$remaining.Count) { exit 0 }
    foreach ($image in $remaining) { [NodexMaintenance]::Stop($image.ProcessId, $root) }
} while ([DateTime]::UtcNow -lt $forceDeadline)
if (@(Get-InstallationProcesses).Count) { throw 'Installation still has running processes' }
