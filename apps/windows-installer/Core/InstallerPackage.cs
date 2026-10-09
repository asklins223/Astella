using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace Astella.Setup.Core;

/// <summary>A signed PE can carry our ZIP and JSON trailer before its Authenticode certificate.</summary>
public sealed class InstallerPackage(string executable, long zipOffset, long zipSize, PackageManifest manifest)
{
    public PackageManifest Manifest { get; } = manifest;
    public long StagingSpaceRequired => checked(zipSize + Manifest.Size + 64 * 1024 * 1024);
    public static InstallerPackage Open(string executable)
    {
        using var stream = File.OpenRead(executable);
        var end = DataEnd(stream);
        Span<byte> footer = stackalloc byte[24];
        // SignTool aligns the certificate table to eight bytes after the payload.
        for (var padding = 0; padding < 8 && end - padding >= footer.Length; padding++)
        {
            stream.Position = end - padding - footer.Length;
            stream.ReadExactly(footer);
            if (!footer[16..].SequenceEqual("ASTELLA1"u8)) continue;
            var jsonSize = BinaryPrimitives.ReadInt64LittleEndian(footer[..8]);
            var zipSize = BinaryPrimitives.ReadInt64LittleEndian(footer[8..16]);
            if (jsonSize <= 0 || jsonSize > 16 * 1024 * 1024 || zipSize <= 0 || zipSize > end - padding - 24 - jsonSize)
                throw new IOException("安装包内容不完整，请重新下载。");
            var json = new byte[checked((int)jsonSize)];
            stream.Position = end - padding - 24 - jsonSize;
            stream.ReadExactly(json);
            var manifest = JsonSerializer.Deserialize<PackageManifest>(json, Identity.Json) ?? throw new IOException("安装包清单缺失。");
            if (manifest.FormatVersion != 1 || manifest.AppId != Identity.AppId || manifest.Arch != "x64"
                || manifest.Size <= 0 || manifest.Files.Length == 0)
                throw new IOException("安装包与当前应用不匹配。");
            return new InstallerPackage(executable, stream.Position - jsonSize - zipSize, zipSize, manifest);
        }
        throw new IOException("这份文件不包含安装内容，请从下载页获取完整安装包。");
    }

    private static long DataEnd(FileStream stream)
    {
        Span<byte> header = stackalloc byte[64];
        if (stream.Length < 64) return stream.Length;
        stream.ReadExactly(header);
        if (!header[..2].SequenceEqual("MZ"u8)) return stream.Length; // Package fixtures can use a small stub.
        var pe = BinaryPrimitives.ReadInt32LittleEndian(header[60..]);
        if (pe < 64 || pe > stream.Length - 160) throw new IOException("安装程序格式无效。");
        stream.Position = pe;
        Span<byte> optional = stackalloc byte[160];
        stream.ReadExactly(optional);
        if (!optional[..4].SequenceEqual("PE\0\0"u8)) throw new IOException("安装程序格式无效。");
        var securityOffset = BinaryPrimitives.ReadUInt16LittleEndian(optional[24..]) == 0x20b ? 168 : 152;
        // PE signature + COFF header (24), then optional-header data directory #4.
        stream.Position = pe + securityOffset;
        Span<byte> cert = stackalloc byte[8];
        stream.ReadExactly(cert);
        var certOffset = BinaryPrimitives.ReadUInt32LittleEndian(cert);
        var certSize = BinaryPrimitives.ReadUInt32LittleEndian(cert[4..]);
        if (certOffset == 0 && certSize == 0) return stream.Length;
        if (certOffset < pe || certSize < 8 || (long)certOffset + certSize != stream.Length)
            throw new IOException("安装程序签名数据不完整。");
        return certOffset;
    }

    public async Task Extract(string staging, IProgress<InstallProgress>? progress, CancellationToken cancel)
    {
        var archivePath = Path.Combine(staging, ".payload.zip");
        var progressClock = Stopwatch.StartNew();
        try
        {
            await using (var source = File.OpenRead(executable))
            await using (var destination = File.Create(archivePath))
            {
                source.Position = zipOffset;
                var remaining = zipSize;
                var buffer = new byte[128 * 1024];
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                while (remaining > 0)
                {
                    var count = await source.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)), cancel);
                    if (count == 0) throw new IOException("安装包被截断，请重新下载。");
                    hash.AppendData(buffer, 0, count);
                    await destination.WriteAsync(buffer.AsMemory(0, count), cancel);
                    remaining -= count;
                    if (progressClock.ElapsedMilliseconds >= 80)
                    {
                        progress?.Report(new(0.2 * (zipSize - remaining) / zipSize, "正在校验安装内容"));
                        progressClock.Restart();
                    }
                }
                if (!Convert.ToHexString(hash.GetHashAndReset()).Equals(Manifest.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("安装包校验未通过，请重新下载。");
            }
            var expected = Manifest.Files.ToDictionary(f => f.Path, StringComparer.OrdinalIgnoreCase);
            using var archive = ZipFile.OpenRead(archivePath);
            long transferred = 0;
            foreach (var entry in archive.Entries)
            {
                cancel.ThrowIfCancellationRequested();
                var name = entry.FullName.Replace('\\', '/');
                if (name.StartsWith('/') || name.Split('/').Any(part => part is ".." or "." || part.Contains(':')))
                    throw new IOException("安装包含有无效文件路径。");
                if ((entry.ExternalAttributes >> 16 & 0xf000) == 0xa000 || (entry.ExternalAttributes & 0x400) != 0)
                    throw new IOException("安装包不能包含文件链接。");
                var target = Path.GetFullPath(Path.Combine(staging, name));
                if (!InstallPaths.IsWithin(target, staging)) throw new IOException("安装包文件超出安装目录。");
                if (name.EndsWith('/')) continue;
                if (!expected.Remove(name, out var file) || file.Size != entry.Length)
                    throw new IOException("安装包文件与清单不一致。");
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                await using var source = entry.Open();
                await using var destination = File.Create(target);
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                var buffer = new byte[128 * 1024];
                int count;
                while ((count = await source.ReadAsync(buffer, cancel)) != 0)
                {
                    hash.AppendData(buffer, 0, count);
                    await destination.WriteAsync(buffer.AsMemory(0, count), cancel);
                    transferred += count;
                    if (progressClock.ElapsedMilliseconds >= 80)
                    {
                        progress?.Report(new(0.2 + 0.65 * transferred / Manifest.Size, "正在安放书房文件"));
                        progressClock.Restart();
                    }
                }
                if (!Convert.ToHexString(hash.GetHashAndReset()).Equals(file.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("书房文件校验未通过，请重新下载。");
            }
            if (expected.Count != 0 || transferred != Manifest.Size
                || !File.Exists(Path.Combine(staging, Identity.Executable)) || !File.Exists(Path.Combine(staging, Identity.Uninstaller)))
                throw new IOException("安装包缺少必要文件。");
        }
        finally { File.Delete(archivePath); }
    }
}
