using System.IO;
using System.Runtime.InteropServices;
using Astella.Setup.Core;
using Microsoft.Win32;

namespace Astella.Setup;

internal sealed class WindowsRegistration : IInstallationRegistration
{
    private const string InstallKey = @"Software\" + Identity.RegistryId;
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + Identity.RegistryId;
    private static string StartShortcut => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "拾星笔记.lnk");
    private static string DesktopShortcut => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "拾星笔记.lnk");

    public InstalledInstallation? Read()
    {
        using var key = Registry.CurrentUser.OpenSubKey(InstallKey);
        var location = key?.GetValue("InstallLocation") as string;
        if (string.IsNullOrWhiteSpace(location) || !File.Exists(Path.Combine(location, Identity.Executable))) return null;
        return InstallPaths.ReadManifest(location) ?? new(Identity.AppId, "legacy", location,
            File.Exists(DesktopShortcut), [], "");
    }

    public void Register(InstalledInstallation installation) => OnSta(() =>
    {
        using var install = Registry.CurrentUser.CreateSubKey(InstallKey);
        install.SetValue("InstallLocation", installation.InstallDirectory);
        using var uninstall = Registry.CurrentUser.CreateSubKey(UninstallKey);
        var executable = Path.Combine(installation.InstallDirectory, Identity.Executable);
        var command = $"\"{Path.Combine(installation.InstallDirectory, Identity.Uninstaller)}\" --uninstall --install-dir \"{installation.InstallDirectory}\"";
        uninstall.SetValue("DisplayName", "拾星笔记");
        uninstall.SetValue("DisplayVersion", installation.Version);
        uninstall.SetValue("Publisher", "Astella");
        uninstall.SetValue("DisplayIcon", executable);
        uninstall.SetValue("InstallLocation", installation.InstallDirectory);
        uninstall.SetValue("UninstallString", command);
        uninstall.SetValue("QuietUninstallString", command + " --quiet");
        uninstall.SetValue("NoModify", 1, RegistryValueKind.DWord);
        uninstall.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        uninstall.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, installation.Files.Sum(f => f.Size) / 1024), RegistryValueKind.DWord);
        CreateShortcut(StartShortcut, executable);
        if (installation.DesktopShortcut) CreateShortcut(DesktopShortcut, executable);
        else DeleteOwnedShortcut(DesktopShortcut, installation.InstallDirectory);
    });

    public void Remove(string installDirectory) => OnSta(() =>
    {
        using (var key = Registry.CurrentUser.OpenSubKey(InstallKey))
            if (key?.GetValue("InstallLocation") is string registered && !registered.Equals(installDirectory, InstallPaths.Comparison))
                throw new IOException("安装登记已发生变化，已停止移除。");
        DeleteOwnedShortcut(StartShortcut, installDirectory);
        DeleteOwnedShortcut(DesktopShortcut, installDirectory);
        Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
        Registry.CurrentUser.DeleteSubKeyTree(InstallKey, false);
    });

    private static void OnSta(Action action)
    {
        if (Thread.CurrentThread.GetApartmentState() == ApartmentState.STA) { action(); return; }
        Exception? failure = null;
        var thread = new Thread(() => { try { action(); } catch (Exception error) { failure = error; } });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure != null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }

    private static void CreateShortcut(string path, string executable)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var type = Type.GetTypeFromProgID("WScript.Shell") ?? throw new IOException("无法创建 Windows 快捷方式。");
        dynamic shell = Activator.CreateInstance(type)!;
        dynamic shortcut = shell.CreateShortcut(path);
        try
        {
            shortcut.TargetPath = executable;
            shortcut.WorkingDirectory = Path.GetDirectoryName(executable);
            shortcut.Description = "Astella 拾星笔记";
            shortcut.IconLocation = executable + ",0";
            shortcut.Save();
        }
        finally { Marshal.FinalReleaseComObject(shortcut); Marshal.FinalReleaseComObject(shell); }
    }

    private static void DeleteOwnedShortcut(string path, string directory)
    {
        if (!File.Exists(path)) return;
        var type = Type.GetTypeFromProgID("WScript.Shell") ?? throw new IOException("无法读取 Windows 快捷方式。");
        dynamic shell = Activator.CreateInstance(type)!;
        dynamic shortcut = shell.CreateShortcut(path);
        try
        {
            string target = shortcut.TargetPath;
            if (Path.GetFullPath(target).Equals(Path.Combine(directory, Identity.Executable), InstallPaths.Comparison)) File.Delete(path);
        }
        finally { Marshal.FinalReleaseComObject(shortcut); Marshal.FinalReleaseComObject(shell); }
    }
}
