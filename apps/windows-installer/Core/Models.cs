using System.Text.Json;

namespace Astella.Setup.Core;

public static class Identity
{
    public const string AppId = "com.asklins.astella";
    // Preserve the existing HKCU identity when upgrading an older installation.
    public const string RegistryId = "c1f7918f-5d82-5edd-bbb5-ea9046add1bb";
    public const string Executable = "Astella.exe";
    public const string Uninstaller = "Uninstall Astella.exe";
    public const string InstallManifest = "astella-install.json";
    public const string LicenseId = "PolyForm-Noncommercial-1.0.0";
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
}

public sealed record PackageFile(string Path, long Size, string Sha256);
public sealed record PackageManifest(int FormatVersion, string AppId, string Version, string Arch,
    long Size, string Sha256, PackageFile[] Files);
public sealed record InstalledInstallation(string AppId, string Version, string InstallDirectory,
    bool DesktopShortcut, PackageFile[] Files, string LicenseId = Identity.LicenseId);
public sealed record InstallProgress(double Fraction, string Message);

public interface IInstallationRegistration
{
    InstalledInstallation? Read();
    void Register(InstalledInstallation installation);
    void Remove(string installDirectory);
}

public sealed record InstallerOptions(bool Uninstall = false, bool Quiet = false, bool Update = false,
    bool Launch = false, bool DeleteData = false, bool DesktopShortcut = true,
    string? InstallDirectory = null, int? WaitPid = null, string? Receipt = null,
    string? FromVersion = null, string? TargetVersion = null)
{
    public static InstallerOptions Parse(string[] args)
    {
        var options = new InstallerOptions();
        for (var i = 0; i < args.Length; i++)
        {
            string Value() => ++i < args.Length ? args[i] : throw new ArgumentException($"缺少 {args[i - 1]} 的值。");
            var arg = args[i];
            options = arg switch
            {
                "--uninstall" => options with { Uninstall = true },
                "--quiet" or "/S" => options with { Quiet = true },
                "--update" or "--updated" => options with { Update = true },
                "--launch" or "--force-run" => options with { Launch = true },
                "--delete-app-data" => options with { DeleteData = true },
                "--no-desktop-shortcut" => options with { DesktopShortcut = false },
                "--install-dir" => options with { InstallDirectory = Value() },
                "--wait-pid" => options with { WaitPid = int.Parse(Value()) },
                "--receipt" => options with { Receipt = Value() },
                "--from-version" => options with { FromVersion = Value() },
                "--target-version" => options with { TargetVersion = Value() },
                // Old clients pass these switches when launching the next release's EXE.
                "--keep-shortcuts" or "/currentuser" => options,
                _ when arg.StartsWith("/D=", StringComparison.OrdinalIgnoreCase) => options with { InstallDirectory = arg[3..] },
                _ => throw new ArgumentException($"不支持的安装参数：{arg}")
            };
        }
        if (options.Update && options.DeleteData) throw new ArgumentException("更新不会清除本机资料。");
        if (options.Update && options.Uninstall) throw new ArgumentException("不能同时更新和卸载。");
        if (options.WaitPid <= 0) throw new ArgumentException("等待的进程编号无效。");
        return options;
    }
}
