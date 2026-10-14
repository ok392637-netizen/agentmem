param(
  [string]$Node = 'node',
  [string]$Script,
  [string]$Agent = 'claude',
  [string]$Running = "$env:USERPROFILE\.agentmem\auto.running",
  [int]$MaxSeconds = 120
)
# Window watcher: snapshot visible top-level windows, fire the trigger,
# then report every NEW visible window and every FOREGROUND change until
# the worker releases its lock. Pure ASCII on purpose (PS 5.1 + GBK).
#
# A foreground change only counts as SUSPECT when the window that took focus
# is new during the test, or belongs to a console host. Windows are enumerated
# globally, so the user's own apps (seen: steamwebhelper) can take focus in the
# middle of a run; that is noise, not our process stealing focus.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ConsoleHosts = @('WindowsTerminal', 'conhost', 'OpenConsole')
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string Describe(IntPtr h) {
    var t = new StringBuilder(512); GetWindowText(h, t, 512);
    var c = new StringBuilder(256); GetClassName(h, c, 256);
    uint pid; GetWindowThreadProcessId(h, out pid);
    return h.ToInt64() + "|" + c + "|" + pid + "|" + t;
  }
  public static List<string> Snap() {
    var r = new List<string>();
    EnumWindows((h, l) => { if (IsWindowVisible(h)) r.Add(Describe(h)); return true; }, IntPtr.Zero);
    return r;
  }
}
"@

function Name($w) {
  $p = [int]($w.Split('|')[2])
  $pr = Get-Process -Id $p -ErrorAction SilentlyContinue
  if ($pr) { return $pr.ProcessName } else { return '(exited)' }
}

if (Test-Path $Running) { Write-Output "ABORT: $Running exists (a worker is running, or a killed one left it behind)"; exit 2 }

$base = @{}
foreach ($w in [WW]::Snap()) { $base[$w.Split('|')[0]] = 1 }
$fg0 = [WW]::Describe([WW]::GetForegroundWindow())
Write-Output ("baseline: {0} visible windows; foreground = {1}" -f $base.Count, $fg0)

$t0 = Get-Date
& $Node $Script --agent $Agent
Write-Output ("trigger returned after {0} ms" -f [int]((Get-Date) - $t0).TotalMilliseconds)

$seen = @{}
$newCount = 0
$fgChanges = 0
$suspect = 0
$lastFg = $fg0
$sawWorker = $false
while (((Get-Date) - $t0).TotalSeconds -lt $MaxSeconds) {
  if (Test-Path $Running) { $sawWorker = $true }
  foreach ($w in [WW]::Snap()) {
    $h = $w.Split('|')[0]
    if (-not $base.ContainsKey($h) -and -not $seen.ContainsKey($h)) {
      $seen[$h] = 1; $newCount++
      Write-Output ("+{0,6:N1}s  NEW WINDOW  {1}  proc={2}" -f ((Get-Date) - $t0).TotalSeconds, $w, (Name $w))
    }
  }
  $fg = [WW]::Describe([WW]::GetForegroundWindow())
  if ($fg -ne $lastFg) {
    $fgChanges++
    $pn = Name $fg
    $isNew = $seen.ContainsKey($fg.Split('|')[0])
    $tag = 'foreground'
    if ($isNew -or ($ConsoleHosts -contains $pn)) { $suspect++; $tag = 'FOREGROUND*' }
    Write-Output ("+{0,6:N1}s  {1}  {2}  proc={3}" -f ((Get-Date) - $t0).TotalSeconds, $tag, $fg, $pn)
    $lastFg = $fg
  }
  # worker done = it took the lock and released it again
  if ($sawWorker -and -not (Test-Path $Running)) { break }
  Start-Sleep -Milliseconds 80
}
Write-Output ("RESULT  sawWorker={0}  newWindows={1}  suspectForeground={2}  foregroundChanges={3}  elapsed={4:N1}s" -f $sawWorker, $newCount, $suspect, $fgChanges, ((Get-Date) - $t0).TotalSeconds)
