using System.Diagnostics;
using System.Text.Json;

namespace Astella.Setup.Core;

public sealed class InstallEngine(IInstallationRegistration registration, string userData)
{
    public async Task<InstalledInstallation> Install(InstallerPackage package, InstallerOptions options,
        IProgress<InstallProgress>? progress = null, CancellationToken cancel = default)
    {
        var target = InstallPaths.Validate(options.InstallDirectory ?? throw new IOException("尚未选择安装位置。"), userData);
        var registered = registration.Read();
        if (registered != null && !target.Equals(registered.InstallDirectory, InstallPaths.Comparison))
            throw new IOException("已有安装，请使用原位置；如需移动，请先卸载并保留本机资料。");
        if (options.TargetVersion is not null && options.TargetVersion != package.Manifest.Version)
            throw new IOException("安装包版本与所选更新不一致。");
        var previous = InstallPaths.ReadManifest(target);
        if (Directory.Exists(target) && Directory.EnumerateFileSystemEntries(target).Any() && previous == null)
        {
            if (registered == null || !target.Equals(registered.InstallDirectory, InstallPaths.Comparison)
                || !File.Exists(Path.Combine(target, Identity.Executable)))
                throw new IOException("此文件夹已有其他内容，请选择空文件夹或现有的拾星笔记目录。");
            previous = registered;
        }
        var parent = Path.GetDirectoryName(target)!;
        if (new DriveInfo(Path.GetPathRoot(target)!).AvailableFreeSpace < package.StagingSpaceRequired)
            throw new IOException("磁盘可用空间不足，请腾出空间或选择其他磁盘后重试。");
        Directory.CreateDirectory(parent);
        InstallPaths.RejectReparsePoints(parent);
        var workspace = Path.Combine(parent, ".astella-install-" + Guid.NewGuid().ToString("N"));
        var staged = Path.Combine(workspace, "next");
        var backup = Path.Combine(workspace, "previous");
        Directory.CreateDirectory(staged);
        var record = new InstalledInstallation(Identity.AppId, package.Manifest.Version, target,
            options.Update ? previous?.DesktopShortcut ?? options.DesktopShortcut : options.DesktopShortcut, package.Manifest.Files);
        var movedOld = false;
        var movedNew = false;
        var committed = false;
        try
        {
            await package.Extract(staged, progress, cancel);
            await File.WriteAllTextAsync(Path.Combine(staged, Identity.InstallManifest), JsonSerializer.Serialize(record, Identity.Json), cancel);
            await WaitForParent(options.WaitPid, cancel);
            cancel.ThrowIfCancellationRequested();
            // The commit is deliberately not cancellable; rollback owns every failure from here.
            progress?.Report(new(0.9, "正在完成安装，请稍候"));
            InstallPaths.RejectReparsePoints(target);
            if (Directory.Exists(target))
            {
                await MoveAfterFilesReleased(target, backup);
                movedOld = true;
            }
            Directory.Move(staged, target);
            movedNew = true;
            registration.Register(record);
            committed = true;
            progress?.Report(new(1, "书房已准备好"));
            return record;
        }
        catch
        {
            if (movedNew) Directory.Delete(target, true);
            if (movedOld) Directory.Move(backup, target);
            if (movedNew)
            {
                if (previous != null) registration.Register(previous);
                else registration.Remove(target);
            }
            throw;
        }
        finally
        {
            // Locked antivirus scans may leave only a backup; never turn successful install into failure.
            if (committed || !Directory.Exists(backup))
                try { Directory.Delete(workspace, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    public async Task Uninstall(InstallerOptions options, IProgress<InstallProgress>? progress = null)
    {
        var target = InstallPaths.Validate(options.InstallDirectory ?? throw new IOException("未找到安装目录。"), userData);
        var record = InstallPaths.ReadManifest(target) ?? throw new IOException("缺少安装标记，无法确认要移除的文件夹。");
        var registered = registration.Read();
        if (registered != null && !target.Equals(registered.InstallDirectory, InstallPaths.Comparison))
            throw new IOException("安装记录指向其他目录，已停止卸载。");
        await WaitForParent(options.WaitPid, default);
        // Run from an external helper so Windows can release the uninstaller's own EXE.
        var removed = Path.Combine(Path.GetDirectoryName(target)!, ".astella-uninstall-" + Guid.NewGuid().ToString("N"));
        progress?.Report(new(0.25, "正在移除应用"));
        await MoveAfterFilesReleased(target, removed);
        try { registration.Remove(target); }
        catch { Directory.Move(removed, target); registration.Register(record); throw; }
        Directory.Delete(removed, true);
        if (options.DeleteData && Directory.Exists(userData))
        {
            progress?.Report(new(0.75, "正在清除本机草稿、缓存和语音模型"));
            InstallPaths.RejectReparsePoints(userData);
            Directory.Delete(userData, true);
        }
        progress?.Report(new(1, "已完成卸载"));
    }

    private static async Task WaitForParent(int? pid, CancellationToken cancel)
    {
        if (pid is null) return;
        Process process;
        try { process = Process.GetProcessById(pid.Value); }
        catch (ArgumentException) { return; }
        using (process)
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel))
        {
            timeout.CancelAfter(TimeSpan.FromSeconds(90));
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
            { throw new IOException("拾星笔记还未退出，请先关闭书房，再重试。"); }
        }
    }

    private static async Task MoveAfterFilesReleased(string source, string destination)
    {
        var timeout = Stopwatch.StartNew();
        while (true)
        {
            try { Directory.Move(source, destination); return; }
            catch (IOException) when (timeout.Elapsed < TimeSpan.FromSeconds(30)) { await Task.Delay(500); }
            catch (UnauthorizedAccessException) { throw new IOException("文件夹无法写入，请选择你有写入权限的位置。"); }
            catch (IOException) { throw new IOException("书房文件仍被使用，请关闭拾星笔记和相关窗口后重试。"); }
        }
    }
}
