using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Runtime.Versioning;
using System.Text;
using Astella.Setup.Core;

namespace Astella.Setup;

[SupportedOSPlatform("windows")]
internal static class WindowsShortcut
{
    // Use the Unicode Shell Link interfaces directly. WScript's dynamic
    // IDispatch binding failed in the self-contained Windows CI installer.
    public static void Create(string path, string executable) => OnSta(() =>
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        var link = (IShellLinkW)new ShellLink();
        try
        {
            link.SetPath(executable);
            link.SetWorkingDirectory(Path.GetDirectoryName(executable)!);
            link.SetDescription("Astella 拾星笔记");
            link.SetIconLocation(executable, 0);
            ((IPersistFile)link).Save(path, true);
        }
        finally { Marshal.FinalReleaseComObject(link); }
    });

    public static string ReadTarget(string path)
    {
        var target = "";
        OnSta(() =>
        {
            var link = (IShellLinkW)new ShellLink();
            try
            {
                ((IPersistFile)link).Load(path, 0);
                var buffer = new StringBuilder(32768);
                link.GetPath(buffer, buffer.Capacity, IntPtr.Zero, 4); // SLGP_RAWPATH; never resolve or launch.
                target = buffer.ToString();
            }
            finally { Marshal.FinalReleaseComObject(link); }
        });
        return target;
    }

    public static void DeleteIfOwned(string path, string directory) => OnSta(() =>
    {
        if (!File.Exists(path)) return;
        var target = ReadTarget(path);
        if (!string.IsNullOrWhiteSpace(target)
            && Path.GetFullPath(target).Equals(Path.Combine(directory, Identity.Executable), InstallPaths.Comparison))
            File.Delete(path);
    });

    internal static void OnSta(Action action)
    {
        if (Thread.CurrentThread.GetApartmentState() == ApartmentState.STA) { action(); return; }
        Exception? failure = null;
        var thread = new Thread(() => { try { action(); } catch (Exception error) { failure = error; } });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure != null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink { }

    // Method order follows IShellLinkW in the Windows SDK's ShObjIdl_core.h:
    // https://learn.microsoft.com/windows/win32/api/shobjidl_core/nn-shobjidl_core-ishelllinkw
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, IntPtr findData, uint flags);
        void GetIDList(out IntPtr idList);
        void SetIDList(IntPtr idList);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int capacity);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int capacity);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int capacity);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(out ushort hotkey);
        void SetHotkey(ushort hotkey);
        void GetShowCmd(out int command);
        void SetShowCmd(int command);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }
}
