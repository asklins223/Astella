using System.Diagnostics;
using System.Text.Json;

namespace Astella.Setup.Core;

public sealed class InstallEngine(IInstallationRegistration registration, string userData)
{
    public async Task<InstallResult> Install(InstallerPackage package, InstallerOptions options,
        IProgress<InstallProgress>? progress = null, CancellationToken cancel = default)
    {
        var target = InstallPaths.Validate(options.InstallDirectory ?? throw new IOException("尚未选择安装位置。"), userData);
        var registered = registration.Read();
        var relocating = registered is not null && !target.Equals(registered.InstallDirectory, InstallPaths.Comparison);
        if (relocating && (InstallPaths.IsWithin(target, registered!.InstallDirectory)
            || InstallPaths.IsWithin(registered.InstallDirectory, target)))
            throw new IOException("新位置不能套在原来的安装目录里，请另选一个独立文件夹。");
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
        var workspace = await StageAsync(package, target, progress, cancel);
        var installation = await CommitAsync(package, options, target, registered ?? previous, workspace, progress, cancel);
        var leftover = relocating ? await ClearPreviousInstallation(registered!.InstallDirectory, userData, progress) : null;
        progress?.Report(new(1, "书房已准备好"));
        return new InstallResult(installation, leftover);
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

    /// <summary>
    /// 写入被拒绝时尝试同卷的其他暂存位置，保留最终整目录替换和回滚能力。
    /// </summary>
    private async Task<string> StageAsync(InstallerPackage package, string target,
        IProgress<InstallProgress>? progress, CancellationToken cancel)
    {
        var volume = Path.GetPathRoot(target)!;
        if (new DriveInfo(volume).AvailableFreeSpace < package.StagingSpaceRequired)
            throw new IOException("磁盘可用空间不足，请腾出空间或选择其他磁盘后重试。");
        Exception? denied = null;
        foreach (var parent in StagingParents(target, volume))
        {
            cancel.ThrowIfCancellationRequested();
            var workspace = Path.Combine(parent, ".astella-install-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(parent);
                InstallPaths.RejectReparsePoints(parent);
                await package.Extract(Path.Combine(workspace, "next"), progress, cancel);
                return workspace;
            }
            catch (Exception error) when (InstallerPackage.IsWriteRefusal(error))
            {
                denied = error;
                TryDeleteTree(workspace);
            }
            catch
            {
                TryDeleteTree(workspace);
                throw;
            }
        }
        throw denied is WriteDeniedException ? denied
            : denied is not null ? new WriteDeniedException(target, denied)
            : new IOException("没能准备好安装用的临时目录，请换一个安装位置后重试。");
    }

    private async Task<InstalledInstallation> CommitAsync(InstallerPackage package, InstallerOptions options,
        string target, InstalledInstallation? previous, string workspace,
        IProgress<InstallProgress>? progress, CancellationToken cancel)
    {
        var staged = Path.Combine(workspace, "next");
        var backup = Path.Combine(workspace, "previous");
        var record = new InstalledInstallation(Identity.AppId, package.Manifest.Version, target,
            options.Update ? previous?.DesktopShortcut ?? options.DesktopShortcut : options.DesktopShortcut, package.Manifest.Files);
        var movedOld = false;
        var movedNew = false;
        var committed = false;
        try
        {
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
            await MoveAfterFilesReleased(staged, target);
            movedNew = true;
            registration.Register(record);
            committed = true;
            return record;
        }
        catch
        {
            if (movedNew) Directory.Delete(target, true);
            if (movedOld) Directory.Move(backup, target);
            if (movedNew)
            {
                // 换位置没装成也要把原位置的登记放回去；登记只有一份，直接注销会把旧安装一起抹掉。
                if (previous != null) registration.Register(previous);
                else registration.Remove(target);
            }
            throw;
        }
        finally
        {
            // Locked antivirus scans may leave only a backup; never turn successful install into failure.
            if (committed || !Directory.Exists(backup))
                TryDeleteTree(workspace);
        }
    }

    private static IEnumerable<string> StagingParents(string target, string volume)
    {
        var seen = new HashSet<string>(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
        foreach (var parent in new[] { Path.GetDirectoryName(target)!,
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Astella"), Path.GetTempPath() })
        {
            if (string.IsNullOrWhiteSpace(parent) || !Path.IsPathRooted(parent)) continue;
            var normalized = Path.TrimEndingDirectorySeparator(Path.GetFullPath(parent));
            if (!Path.GetPathRoot(normalized)!.Equals(volume, InstallPaths.Comparison)) continue;
            // 暂存目录不能落在待替换目录内，否则备份旧程序时会把新程序一起搬走。
            if (normalized.Equals(target, InstallPaths.Comparison) || InstallPaths.IsWithin(normalized, target)) continue;
            if (!seen.Add(normalized)) continue;
            yield return normalized;
        }
    }

    /// <summary>换位置装好之后收起旧程序。清不掉只是一条提示，不能把这次已经装好的安装判成失败。</summary>
    private static async Task<string?> ClearPreviousInstallation(string previous, string userData, IProgress<InstallProgress>? progress)
    {
        if (!File.Exists(Path.Combine(previous, Identity.Executable))) return null;
        progress?.Report(new(0.95, "正在收起旧位置的程序"));
        var trash = Path.Combine(Path.GetDirectoryName(previous)!, ".astella-previous-" + Guid.NewGuid().ToString("N"));
        try
        {
            InstallPaths.Validate(previous, userData);
            await MoveAfterFilesReleased(previous, trash);
            Directory.Delete(trash, true);
            return null;
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            // 搬走了却没删干净，留下的是那个隐藏目录；没搬走就还是原位置。两种都只报路径。
            return Directory.Exists(trash) ? trash : previous;
        }
    }

    private static void TryDeleteTree(string workspace)
    {
        try { Directory.Delete(workspace, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
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
            catch (UnauthorizedAccessException error) { throw new IOException("文件夹无法写入，请选择你有写入权限的位置。", error); }
            catch (IOException error) { throw new IOException("书房文件仍被使用，请关闭拾星笔记和相关窗口后重试。", error); }
        }
    }
}
