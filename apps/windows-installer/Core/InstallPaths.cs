namespace Astella.Setup.Core;

public static class InstallPaths
{
    public static StringComparison Comparison => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    public static string Validate(string directory, string userData)
    {
        if (string.IsNullOrWhiteSpace(directory) || !Path.IsPathFullyQualified(directory))
            throw new IOException("请选择完整的安装目录，例如 D:\\Apps\\Astella。");
        var target = Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory));
        if (target == Path.TrimEndingDirectorySeparator(Path.GetPathRoot(target)!))
            throw new IOException("请为拾星笔记选择独立文件夹，不能安装到磁盘根目录。");
        if (target.StartsWith(@"\\", StringComparison.Ordinal)) throw new IOException("请选择本机磁盘，不能安装到网络共享目录。");
        var protectedPaths = new[] { userData, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            Environment.GetFolderPath(Environment.SpecialFolder.Windows), Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) };
        foreach (var path in protectedPaths.Where(p => !string.IsNullOrWhiteSpace(p)))
        {
            var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
            if (target.Equals(full, Comparison) || IsWithin(full, target) || IsWithin(target, Path.GetFullPath(userData))
                || (!string.IsNullOrWhiteSpace(Environment.GetFolderPath(Environment.SpecialFolder.Windows)) && IsWithin(target, Environment.GetFolderPath(Environment.SpecialFolder.Windows))))
                throw new IOException("此位置包含系统或个人资料，请另选独立文件夹。");
        }
        RejectReparsePoints(target);
        return target;
    }

    public static bool IsWithin(string path, string directory) =>
        path.StartsWith(Path.TrimEndingDirectorySeparator(directory) + Path.DirectorySeparatorChar, Comparison);

    public static void RejectReparsePoints(string path)
    {
        for (var item = Path.GetFullPath(path); !string.IsNullOrEmpty(item); item = Path.GetDirectoryName(item))
            if (Path.Exists(item) && (File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("安装位置含有目录链接，请选择实际文件夹。");
    }

    public static InstalledInstallation? ReadManifest(string directory)
    {
        var file = Path.Combine(directory, Identity.InstallManifest);
        if (!File.Exists(file)) return null;
        var record = System.Text.Json.JsonSerializer.Deserialize<InstalledInstallation>(File.ReadAllText(file), Identity.Json);
        if (record?.AppId != Identity.AppId || !Path.GetFullPath(record.InstallDirectory).Equals(Path.GetFullPath(directory), Comparison))
            throw new IOException("该目录中的安装标记不属于拾星笔记。");
        return record;
    }
}
