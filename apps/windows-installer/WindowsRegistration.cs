using System.IO;
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

    public void Register(InstalledInstallation installation) => WindowsShortcut.OnSta(() =>
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
        WindowsShortcut.Create(StartShortcut, executable);
        if (installation.DesktopShortcut) WindowsShortcut.Create(DesktopShortcut, executable);
        else WindowsShortcut.DeleteIfOwned(DesktopShortcut, installation.InstallDirectory);
    });

    public void Remove(string installDirectory) => WindowsShortcut.OnSta(() =>
    {
        using (var key = Registry.CurrentUser.OpenSubKey(InstallKey))
            if (key?.GetValue("InstallLocation") is string registered && !registered.Equals(installDirectory, InstallPaths.Comparison))
                throw new IOException("安装登记已发生变化，已停止移除。");
        WindowsShortcut.DeleteIfOwned(StartShortcut, installDirectory);
        WindowsShortcut.DeleteIfOwned(DesktopShortcut, installDirectory);
        Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
        Registry.CurrentUser.DeleteSubKeyTree(InstallKey, false);
    });

}
