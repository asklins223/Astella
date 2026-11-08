using Astella.Setup.Core;
using Microsoft.Win32;

namespace Astella.Setup;

/// <summary>
/// 当前用户的 Markdown 文件关联（2026-11）。
///
/// Windows 的默认程序是用户的决定，不是安装器的：这里只把拾星笔记登记进
/// 「打开方式」与「默认应用」候选，并只在某个后缀**原本没有任何默认程序**时
/// 才把自己设为默认。卸载时只回滚仍然指向我们的那部分，用户后来选的别的程序不动。
///
/// 全部写 HKCU，不要求管理员权限，与安装器 asInvoker 的定位一致。
/// </summary>
internal static class MarkdownFileAssociation
{
    private const string ProgId = "Astella.Markdown";
    private const string ExtensionsValuePrefix = "FileAssociationPrevious";
    private static readonly string[] Extensions = [".md", ".markdown", ".mdown", ".mkd"];

    public static void Register(string executable, RegistryKey installKey)
    {
        using (var progId = Registry.CurrentUser.CreateSubKey(@"Software\Classes\" + ProgId))
        {
            progId.SetValue(null, "Markdown 文档");
            using (var icon = progId.CreateSubKey("DefaultIcon"))
                icon.SetValue(null, $"\"{executable}\",0");
            using (var command = progId.CreateSubKey(@"shell\open\command"))
                command.SetValue(null, $"\"{executable}\" \"%1\"");
        }

        using (var application = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Applications\" + Identity.Executable))
        {
            using (var command = application.CreateSubKey(@"shell\open\command"))
                command.SetValue(null, $"\"{executable}\" \"%1\"");
            using (var types = application.CreateSubKey("SupportedTypes"))
                foreach (var extension in Extensions) types.SetValue(extension, string.Empty);
        }

        using (var capabilities = Registry.CurrentUser.CreateSubKey(@"Software\Astella\Capabilities"))
        {
            capabilities.SetValue("ApplicationName", "拾星笔记");
            capabilities.SetValue("ApplicationDescription", "Markdown 笔记与学习书房");
            using (var files = capabilities.CreateSubKey("FileAssociations"))
                foreach (var extension in Extensions) files.SetValue(extension, ProgId);
        }
        using (var registered = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications"))
            registered.SetValue("Astella", @"Software\Astella\Capabilities");

        foreach (var extension in Extensions)
        {
            using var extensionKey = Registry.CurrentUser.CreateSubKey(@"Software\Classes\" + extension);
            using (var openWith = extensionKey.CreateSubKey("OpenWithProgids"))
                openWith.SetValue(ProgId, Array.Empty<byte>(), RegistryValueKind.None);

            var current = extensionKey.GetValue(null) as string;
            if (!string.IsNullOrEmpty(current) && !current.Equals(ProgId, StringComparison.OrdinalIgnoreCase)) continue;

            // 只在原本没有默认程序时接管；用户后来选的别的程序不会被安装器/更新改掉。
            var presentName = ExtensionsValuePrefix + extension + "Present";
            var valueName = ExtensionsValuePrefix + extension + "Value";
            if (installKey.GetValue(presentName) is null)
            {
                installKey.SetValue(presentName, current is null ? 0 : 1, RegistryValueKind.DWord);
                if (current is not null) installKey.SetValue(valueName, current, RegistryValueKind.String);
            }
            extensionKey.SetValue(null, ProgId);
        }
    }

    public static void Remove(RegistryKey? installKey)
    {
        foreach (var extension in Extensions)
        {
            using var extensionKey = Registry.CurrentUser.OpenSubKey(@"Software\Classes\" + extension, writable: true);
            if (extensionKey is null) continue;
            if (string.Equals(extensionKey.GetValue(null) as string, ProgId, StringComparison.OrdinalIgnoreCase))
            {
                var present = installKey?.GetValue(ExtensionsValuePrefix + extension + "Present") as int?;
                var previous = installKey?.GetValue(ExtensionsValuePrefix + extension + "Value") as string;
                if (present == 1 && previous is not null) extensionKey.SetValue(null, previous);
                else extensionKey.DeleteValue(string.Empty, throwOnMissingValue: false);
            }
            using var openWith = extensionKey.OpenSubKey("OpenWithProgids", writable: true);
            openWith?.DeleteValue(ProgId, throwOnMissingValue: false);
        }

        Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\" + ProgId, throwOnMissingSubKey: false);
        Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\Applications\" + Identity.Executable, throwOnMissingSubKey: false);
        using (var registered = Registry.CurrentUser.OpenSubKey(@"Software\RegisteredApplications", writable: true))
            registered?.DeleteValue("Astella", throwOnMissingValue: false);
        Registry.CurrentUser.DeleteSubKeyTree(@"Software\Astella", throwOnMissingSubKey: false);
    }
}
