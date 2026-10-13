# 文件带 UTF-8 BOM：Windows PowerShell 5.1 读没有 BOM 的脚本时按系统的 ANSI 代码页（中文系统是 GBK）解码
# 端到端测试用的 Windows 操作，都只针对测试版的进程（ProcId）或测试数据目录（DataDir），不碰别的程序（keys 除外）：
#   windows     列出进程的顶层窗口：标题|可见|最大化|最小化|前台|扩展样式
#   show        对标题为 Title 的窗口 ShowWindow(Cmd)：3 最大化、9 还原、6 最小化
#   close       给标题为 Title 的窗口发 WM_CLOSE（等于点右上角的关闭按钮）
#   icons       标题为 Title 的窗口的大图标、小图标句柄（0 表示没有，会显示系统默认图标）
#   hotkey      模拟按下全局快捷键 Ctrl+Alt+Key：给进程的 global_hotkey_app 窗口发 WM_HOTKEY（不经过键盘，
#               不会把按键送到别的程序）。global-hotkey 的 id = (modifiers << 16) | Code 序号，Ctrl+Alt = 0x9，KeyA = 19
#   free        Ctrl+Alt+Key 现在有没有被占着：能注册说明没人占（马上放开）；Hold > 0 时占住这么多秒（模拟别的程序占用）
#   bin         Windows 回收站里从 DataDir 删掉的东西（名字|原来的位置），只列这些，不列用户自己的
#   undelete    还原回收站里从 DataDir 删掉的、名字是 Name 的（Name 为空时全部）
#   taskbar     任务栏上名字里带 Name 的按钮
#   lock        独占打开文件 Path（不让删、不让改名），占住 Hold 秒
#   desktop     标题为 Title 的窗口在哪个虚拟桌面（IVirtualDesktopManager）：在不在当前桌面|桌面的 id；问不出来时 err|HRESULT
#   desktops    现在有几个虚拟桌面（explorer 记在注册表里的 VirtualDesktopIDs，没有时算 1 个）
#   keys        真的按下组合键 Keys（如 LWin,Ctrl,D：依次按下、倒着放开），送到系统，会动到整个桌面；只用来新建、切换、关掉虚拟桌面
param(
  [string]$Action,
  [int]$ProcId = 0,
  [string]$Title = "",
  [int]$Cmd = 9,
  [string]$Key = "N",
  [int]$Hold = 0,
  [string]$DataDir = "",
  [string]$Name = "",
  [string]$Path = "",
  [string]$Keys = ""
)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ProgressPreference = "SilentlyContinue"

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
[ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVirtualDesktopManager {
  [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr h, out int onCurrent);
  [PreserveSig] int GetWindowDesktopId(IntPtr h, out Guid id);
}
public class E2E {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  public static string Text(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
  public static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  /** 进程的顶层窗口 */
  public static List<IntPtr> Windows(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static IntPtr Find(uint pid, string cls, string title) {
    foreach (var h in Windows(pid)) if (Class(h) == cls && (title == null || Text(h) == title)) return h;
    return IntPtr.Zero;
  }
  static IVirtualDesktopManager desktops;
  /** 窗口在哪个虚拟桌面：在不在当前桌面|桌面的 id，问不出来时 err|HRESULT */
  public static string Desktop(IntPtr h) {
    if (desktops == null) desktops = (IVirtualDesktopManager)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")));
    int on; Guid id;
    int hr = desktops.IsWindowOnCurrentVirtualDesktop(h, out on);
    if (hr == 0) hr = desktops.GetWindowDesktopId(h, out id); else id = Guid.Empty;
    return hr != 0 ? "err|0x" + hr.ToString("X8") : (on != 0) + "|" + id;
  }
}
"@

function TauriWindow { [E2E]::Find($ProcId, "Tauri Window", $Title) }

switch ($Action) {
  "windows" {
    $fg = [E2E]::GetForegroundWindow()
    foreach ($h in [E2E]::Windows($ProcId)) {
      if ([E2E]::Class($h) -ne "Tauri Window") { continue }
      "{0}|{1}|{2}|{3}|{4}|0x{5:X8}" -f [E2E]::Text($h), [E2E]::IsWindowVisible($h), [E2E]::IsZoomed($h), [E2E]::IsIconic($h), ($h -eq $fg), [E2E]::GetWindowLong($h, -20)
    }
  }
  "show" { $h = TauriWindow; if ($h -ne [IntPtr]::Zero) { [void][E2E]::ShowWindow($h, $Cmd) } }
  "close" { $h = TauriWindow; if ($h -ne [IntPtr]::Zero) { [void][E2E]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) } }
  "icons" {
    $h = TauriWindow
    "{0} {1}" -f [E2E]::SendMessage($h, 0x7F, [IntPtr]1, [IntPtr]0), [E2E]::SendMessage($h, 0x7F, [IntPtr]0, [IntPtr]0)
  }
  "hotkey" {
    $h = [E2E]::Find($ProcId, "global_hotkey_app", $null)
    $code = 19 + ([int][char]$Key - [int][char]'A')
    $id = (0x9 -shl 16) -bor $code
    [void][E2E]::PostMessage($h, 0x312, [IntPtr]$id, [IntPtr](([int][char]$Key -shl 16) -bor 3))
  }
  "free" {
    $ok = [E2E]::RegisterHotKey([IntPtr]::Zero, 0x7E2E, 3, [uint32][char]$Key)
    if ($ok) { if ($Hold -gt 0) { "held"; Start-Sleep -Seconds $Hold }; [void][E2E]::UnregisterHotKey([IntPtr]::Zero, 0x7E2E) }
    "free=$ok"
  }
  { $_ -in "bin", "undelete" } {
    $rb = (New-Object -ComObject Shell.Application).Namespace(10)
    foreach ($item in @($rb.Items())) {
      $from = $item.ExtendedProperty("System.Recycle.DeletedFrom")
      if (-not $from -or -not $from.StartsWith($DataDir, [StringComparison]::OrdinalIgnoreCase)) { continue }
      if ($Action -eq "bin") { "{0}|{1}" -f $item.Name, $from.Substring($DataDir.Length) }
      elseif ($Name -eq "" -or $item.Name -eq $Name) { $item.InvokeVerb("undelete") }
    }
  }
  "taskbar" {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $root = [Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty, "Shell_TrayWnd")
    $tray = $root.FindFirst([Windows.Automation.TreeScope]::Children, $cond)
    foreach ($e in $tray.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
      if ($e.Current.Name.Contains($Name)) { $e.Current.Name }
    }
  }
  "desktop" { [E2E]::Desktop((TauriWindow)) }
  "desktops" {
    $ids = (Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops" -Name VirtualDesktopIDs -ErrorAction SilentlyContinue).VirtualDesktopIDs
    if ($ids) { $ids.Length / 16 } else { 1 }
  }
  "keys" {
    $vk = @{ LWin = 0x5B; Ctrl = 0xA2; Left = 0x25; Right = 0x27; D = 0x44; F4 = 0x73 }
    # Win 键和方向键是扩展键（KEYEVENTF_EXTENDEDKEY = 1），放开加 KEYEVENTF_KEYUP = 2
    $ext = { param($k) if ($k -in "LWin", "Left", "Right") { 1 } else { 0 } }
    $list = @($Keys -split ",")
    foreach ($k in $list) { [E2E]::keybd_event($vk[$k], 0, (& $ext $k), [UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }
    [array]::Reverse($list)
    foreach ($k in $list) { [E2E]::keybd_event($vk[$k], 0, 2 -bor (& $ext $k), [UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }
  }
  "lock" {
    $f = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    "locked"
    Start-Sleep -Seconds $Hold
    $f.Close()
  }
}
