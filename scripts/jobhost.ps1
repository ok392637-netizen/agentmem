# Emulates a host (like codex exec) that runs a hook inside a Job Object with
# KILL_ON_JOB_CLOSE, then exits: every process still in the job dies with it.
# Usage: powershell -File jobhost.ps1 -Node <node.exe> -Script <auto.mjs> -Agent <name> [-Wait 3]
# Pure ASCII on purpose (Windows PowerShell 5.1 reads BOM-less UTF-8 as GBK).
param([string]$Node, [string]$Script, [string]$Agent = 'probe', [int]$Wait = 3)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class KillJob {
  [StructLayout(LayoutKind.Sequential)] public struct BASIC {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct IO { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] public struct EXT {
    public BASIC Basic; public IO Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, uint l);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static string Enter() {
    IntPtr j = CreateJobObject(IntPtr.Zero, null);
    if (j == IntPtr.Zero) return "CreateJobObject failed " + Marshal.GetLastWin32Error();
    EXT e = new EXT(); e.Basic.LimitFlags = 0x2000;   // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(j, 9, ref e, (uint)Marshal.SizeOf(typeof(EXT)))) return "SetInformationJobObject failed " + Marshal.GetLastWin32Error();
    if (!AssignProcessToJobObject(j, GetCurrentProcess())) return "AssignProcessToJobObject failed " + Marshal.GetLastWin32Error();
    return "ok";
  }
}
"@
$r = [KillJob]::Enter()
Write-Output ("job: " + $r)
if ($r -ne 'ok') { exit 2 }
& $Node $Script --agent $Agent
Write-Output ("hook exit: " + $LASTEXITCODE)
Start-Sleep -Seconds $Wait
Write-Output "host exiting (job handle closes, KILL_ON_JOB_CLOSE fires)"
exit 0
