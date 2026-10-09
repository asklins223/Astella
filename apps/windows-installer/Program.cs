using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Text.Json;
using System.Windows;
using Astella.Setup.Core;

namespace Astella.Setup;

internal static class Program
{
    internal static string UserData => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "astella-desktop-client");
    internal static InstallerPackage? Package;
    internal static string? LogPath;

    [STAThread]
    public static int Main(string[] args)
    {
        var quiet = args.Contains("--quiet") || args.Contains("/S");
        InstallerOptions? options = null;
        try
        {
            options = InstallerOptions.Parse(args);
            var self = Environment.ProcessPath ?? throw new IOException("无法确定安装程序位置。");
            if (Path.GetFileName(self).Equals(Identity.Uninstaller, StringComparison.OrdinalIgnoreCase))
                options = options with { Uninstall = true };
            var registration = new WindowsRegistration();
            var registered = registration.Read();
            options = options with { InstallDirectory = options.InstallDirectory ?? registered?.InstallDirectory
                ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Astella") };
            if (options.Uninstall && Path.GetDirectoryName(self)!.Equals(options.InstallDirectory, InstallPaths.Comparison))
            {
                // An uninstaller cannot delete its own executable. Relocate before taking the lock or showing UI.
                var helper = Path.Combine(Path.GetTempPath(), "astella-uninstall-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(helper);
                var copy = Path.Combine(helper, "AstellaSetup.exe");
                File.Copy(self, copy);
                var start = new ProcessStartInfo(copy) { UseShellExecute = false };
                foreach (var arg in args) start.ArgumentList.Add(arg);
                if (!args.Contains("--uninstall")) start.ArgumentList.Add("--uninstall");
                if (!args.Contains("--install-dir")) { start.ArgumentList.Add("--install-dir"); start.ArgumentList.Add(options.InstallDirectory!); }
                if (options.WaitPid is null) { start.ArgumentList.Add("--wait-pid"); start.ArgumentList.Add(Environment.ProcessId.ToString()); }
                using var child = Process.Start(start) ?? throw new IOException("无法启动卸载程序。");
                return 0;
            }
            using var mutex = new Mutex(true, @"Local\Astella.Setup." + WindowsIdentity.GetCurrent().User!.Value, out var ownsMutex);
            if (!ownsMutex) throw new IOException("已有安装或卸载在进行，请完成后再试。");
            if (!options.Uninstall) Package = InstallerPackage.Open(self);
            var engine = new InstallEngine(registration, UserData);
            if (options.Quiet)
            {
                if (options.Uninstall) engine.Uninstall(options).GetAwaiter().GetResult();
                else engine.Install(Package!, options).GetAwaiter().GetResult();
                if (options.Launch && !options.Uninstall) Launch(options.InstallDirectory!);
                return 0;
            }
            var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            var window = new MainWindow(engine, options, registered);
            return app.Run(window);
        }
        catch (Exception error)
        {
            RecordFailure(options, error);
            if (!quiet) MessageBox.Show(error.Message + "\n\n" + (LogPath is null ? "" : "诊断记录：" + LogPath), "拾星笔记", MessageBoxButton.OK, MessageBoxImage.Warning);
            return 1;
        }
    }

    internal static void Launch(string directory)
    {
        var start = new ProcessStartInfo(Path.Combine(directory, Identity.Executable)) { UseShellExecute = true, WorkingDirectory = directory };
        start.ArgumentList.Add("--updated");
        using var process = Process.Start(start) ?? throw new IOException("书房已安装，但暂时无法打开。请从开始菜单重试。");
    }

    internal static void RecordFailure(InstallerOptions? options, Exception error)
    {
        try
        {
            var logDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Astella", "setup-logs");
            Directory.CreateDirectory(logDirectory);
            LogPath = Path.Combine(logDirectory, DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + ".log");
            File.WriteAllText(LogPath, error.ToString());
            if (options?.Receipt is not null && options.FromVersion is not null && options.TargetVersion is not null)
            {
                // The main process owns the receipt; accept only the default profile's exact file.
                var receipt = Path.GetFullPath(options.Receipt);
                if (!receipt.Equals(Path.Combine(UserData, "update-install.json"), InstallPaths.Comparison)) return;
                Directory.CreateDirectory(UserData);
                File.WriteAllText(receipt + ".tmp", JsonSerializer.Serialize(new { fromVersion = options.FromVersion,
                    version = options.TargetVersion, status = "failed" }, Identity.Json));
                File.Move(receipt + ".tmp", receipt, true);
            }
        }
        catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}
