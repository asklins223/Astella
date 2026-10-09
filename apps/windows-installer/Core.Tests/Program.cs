using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using Astella.Setup.Core;

if (args.Length == 2 && args[0] == "--verify-package")
{
    using var fixture = new Fixture();
    var package = InstallerPackage.Open(Path.GetFullPath(args[1]));
    await fixture.Engine.Install(package, fixture.Options);
    var license = File.ReadAllText(Path.Combine(fixture.Target, "LICENSE.txt"));
    Assert(license.Contains("PolyForm Noncommercial License 1.0.0"));
    await fixture.Engine.Uninstall(fixture.Options with { Uninstall = true });
    Assert(File.Exists(fixture.Draft));
    Console.WriteLine($"Verified complete installer v{package.Manifest.Version}: {package.Manifest.Files.Length} files, all hashes, install and retained-data uninstall.");
    return;
}

var tests = new (string Name, Func<Fixture, Task> Run)[]
{
    ("custom directory with spaces and Chinese; verified files; default data retention", async f =>
    {
        var install = await f.Engine.Install(f.Package(), f.Options);
        Assert(install.InstallDirectory == f.Target && File.Exists(Path.Combine(f.Target, Identity.Uninstaller)));
        Assert(InstallPaths.ReadManifest(f.Target)?.LicenseId == Identity.LicenseId);
        await f.Engine.Uninstall(f.Options with { Uninstall = true });
        Assert(!Directory.Exists(f.Target) && File.ReadAllText(f.Draft) == "unsynced draft" && f.Registry.Current == null);
    }),
    ("upgrade replaces stale files and retains profile and shortcut preferences", async f =>
    {
        await f.Engine.Install(f.Package("1.0.0"), f.Options with { DesktopShortcut = false });
        File.WriteAllText(Path.Combine(f.Target, "stale.dll"), "old");
        await f.Engine.Install(f.Package("2.0.0"), f.Options with { Update = true, TargetVersion = "2.0.0" });
        Assert(File.ReadAllText(Path.Combine(f.Target, Identity.Executable)) == "app 2.0.0");
        Assert(!File.Exists(Path.Combine(f.Target, "stale.dll")) && !f.Registry.Current!.DesktopShortcut);
        Assert(File.ReadAllText(f.Draft) == "unsynced draft");
    }),
    ("registration failure rolls back the complete old application", async f =>
    {
        await f.Engine.Install(f.Package("1.0.0"), f.Options);
        f.Registry.FailNextRegister = true;
        await Reject(() => f.Engine.Install(f.Package("2.0.0"), f.Options with { Update = true }));
        Assert(File.ReadAllText(Path.Combine(f.Target, Identity.Executable)) == "app 1.0.0");
        Assert(f.Registry.Current!.Version == "1.0.0" && File.ReadAllText(f.Draft) == "unsynced draft");
    }),
    ("corrupted ZIP and corrupted file hash cannot replace the installed version", async f =>
    {
        await f.Engine.Install(f.Package("1.0.0"), f.Options);
        await Reject(() => f.Engine.Install(f.Package("2.0.0", corruptZip: true), f.Options));
        await Reject(() => f.Engine.Install(f.Package("2.0.0", corruptFile: true), f.Options));
        Assert(f.Registry.Current!.Version == "1.0.0");
    }),
    ("ZIP traversal and symlink entries cannot write outside staging", async f =>
    {
        await Reject(() => f.Engine.Install(f.Package(path: "../escape"), f.Options));
        await Reject(() => f.Engine.Install(f.Package(symlink: true), f.Options));
        Assert(!Directory.Exists(f.Target) && !File.Exists(Path.Combine(f.Root, "escape")));
    }),
    ("cancelled preparation leaves existing program and profile untouched", async f =>
    {
        await f.Engine.Install(f.Package("1.0.0"), f.Options);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Reject(() => f.Engine.Install(f.Package("2.0.0"), f.Options, cancel: cancellation.Token));
        Assert(f.Registry.Current!.Version == "1.0.0" && File.ReadAllText(f.Draft) == "unsynced draft");
    }),
    ("only explicitly selected local data is removed; external exports stay", async f =>
    {
        var export = Path.Combine(f.Root, "notes-export.md");
        File.WriteAllText(export, "export");
        await f.Engine.Install(f.Package(), f.Options);
        await f.Engine.Uninstall(f.Options with { Uninstall = true, DeleteData = true });
        Assert(!Directory.Exists(f.Profile) && File.ReadAllText(export) == "export");
    }),
    ("foreign occupied directory, disk root, profile and relative paths are rejected", async f =>
    {
        Directory.CreateDirectory(f.Target);
        File.WriteAllText(Path.Combine(f.Target, "other-app"), "keep");
        await Reject(() => f.Engine.Install(f.Package(), f.Options));
        Assert(File.ReadAllText(Path.Combine(f.Target, "other-app")) == "keep");
        foreach (var path in new[] { "relative", Path.GetPathRoot(f.Root)!, f.Profile, Path.Combine(f.Profile, "Astella") })
            await Reject(() => f.Engine.Install(f.Package(), f.Options with { InstallDirectory = path }));
    }),
    ("registered legacy installation migrates without invoking its uninstaller", async f =>
    {
        Directory.CreateDirectory(f.Target);
        File.WriteAllText(Path.Combine(f.Target, Identity.Executable), "legacy");
        f.Registry.Current = new(Identity.AppId, "legacy", f.Target, true, [], "");
        await f.Engine.Install(f.Package("2.0.0"), f.Options with { Update = true });
        Assert(InstallPaths.ReadManifest(f.Target)?.Version == "2.0.0");
    }),
    ("wrong target version and attempted update relocation are rejected", async f =>
    {
        await f.Engine.Install(f.Package(), f.Options);
        await Reject(() => f.Engine.Install(f.Package(), f.Options with { TargetVersion = "9.0.0" }));
        await Reject(() => f.Engine.Install(f.Package(), f.Options with { Update = true, InstallDirectory = Path.Combine(f.Root, "elsewhere") }));
        Assert(f.Registry.Current!.InstallDirectory == f.Target);
    }),
    ("unsigned and Authenticode-padded PE trailers locate the same payload", async f =>
    {
        await f.Engine.Install(f.Package(signed: true), f.Options);
        Assert(File.ReadAllText(Path.Combine(f.Target, Identity.Executable)) == "app 1.0.0");
    }),
    ("uninstall registration failure restores the installed folder", async f =>
    {
        await f.Engine.Install(f.Package(), f.Options);
        f.Registry.FailRemove = true;
        await Reject(() => f.Engine.Uninstall(f.Options with { Uninstall = true }));
        Assert(File.Exists(Path.Combine(f.Target, Identity.Executable)) && File.Exists(f.Draft));
    }),
    ("new and legacy updater arguments preserve literal custom paths", f =>
    {
        var options = InstallerOptions.Parse(["--updated", "/S", "--force-run", "/D=" + f.Target]);
        Assert(options.Update && options.Quiet && options.Launch && options.InstallDirectory == f.Target);
        var next = InstallerOptions.Parse(["--update", "--install-dir", f.Target, "--wait-pid", "42", "--target-version", "2.0.0"]);
        Assert(next.WaitPid == 42 && next.InstallDirectory == f.Target);
        AssertThrows(() => InstallerOptions.Parse(["--update", "--delete-app-data"]));
        AssertThrows(() => InstallerOptions.Parse(["--install-dir"]));
        return Task.CompletedTask;
    }),
};

foreach (var test in tests)
{
    using var fixture = new Fixture();
    await test.Run(fixture);
    Console.WriteLine("PASS " + test.Name);
}
Console.WriteLine($"{tests.Length} installer core scenarios passed.");

static void Assert(bool condition) { if (!condition) throw new Exception("Assertion failed"); }
static void AssertThrows(Action action) { try { action(); } catch { return; } throw new Exception("Expected rejection"); }
static async Task Reject(Func<Task> action) { try { await action(); } catch { return; } throw new Exception("Expected rejection"); }

sealed class FakeRegistration : IInstallationRegistration
{
    public InstalledInstallation? Current;
    public bool FailNextRegister;
    public bool FailRemove;
    public InstalledInstallation? Read() => Current;
    public void Register(InstalledInstallation record)
    {
        if (FailNextRegister) { FailNextRegister = false; throw new IOException("registry failure"); }
        Current = record;
    }
    public void Remove(string directory) { if (FailRemove) throw new IOException("remove failure"); Current = null; }
}

sealed class Fixture : IDisposable
{
    public readonly string Root = Path.Combine(OperatingSystem.IsMacOS() ? "/private/tmp" : Path.GetTempPath(), "astella-core 中文 ' " + Guid.NewGuid().ToString("N"));
    public string Target => Path.Combine(Root, "my apps", "拾星笔记");
    public string Profile => Path.Combine(Root, "profile");
    public string Draft => Path.Combine(Profile, "draft.txt");
    public readonly FakeRegistration Registry = new();
    public InstallEngine Engine => new(Registry, Profile);
    public InstallerOptions Options => new(InstallDirectory: Target);
    public Fixture() { Directory.CreateDirectory(Profile); File.WriteAllText(Draft, "unsynced draft"); }
    public InstallerPackage Package(string version = "1.0.0", string? path = null, bool corruptZip = false,
        bool corruptFile = false, bool symlink = false, bool signed = false)
    {
        var zip = Path.Combine(Root, Guid.NewGuid() + ".zip");
        var files = new List<PackageFile>();
        using (var archive = ZipFile.Open(zip, ZipArchiveMode.Create))
        {
            foreach (var (name, content) in new[] { (path ?? Identity.Executable, "app " + version), (Identity.Uninstaller, "uninstaller"), ("resources/中文.txt", "resource") })
            {
                var bytes = System.Text.Encoding.UTF8.GetBytes(content);
                var entry = archive.CreateEntry(name);
                if (symlink) entry.ExternalAttributes = 0xa000 << 16;
                using var destination = entry.Open();
                destination.Write(bytes);
                files.Add(new(name, bytes.Length, corruptFile ? "wrong" : Convert.ToHexString(SHA256.HashData(bytes))));
            }
        }
        var zipped = File.ReadAllBytes(zip);
        var manifest = new PackageManifest(1, Identity.AppId, version, "x64", files.Sum(f => f.Size),
            corruptZip ? "wrong" : Convert.ToHexString(SHA256.HashData(zipped)), files.ToArray());
        var json = JsonSerializer.SerializeToUtf8Bytes(manifest, Identity.Json);
        var exe = Path.Combine(Root, Guid.NewGuid() + ".exe");
        using (var output = File.Create(exe))
        using (var writer = new BinaryWriter(output))
        {
            var stub = new byte[512];
            if (signed)
            {
                stub[0] = (byte)'M'; stub[1] = (byte)'Z';
                BitConverter.GetBytes(64).CopyTo(stub, 60);
                "PE\0\0"u8.CopyTo(stub.AsSpan(64));
                BitConverter.GetBytes((ushort)0x20b).CopyTo(stub, 88);
            }
            writer.Write(stub); writer.Write(zipped); writer.Write(json);
            writer.Write((long)json.Length); writer.Write((long)zipped.Length); writer.Write("ASTELLA1"u8);
            if (signed)
            {
                while (output.Position % 8 != 0) writer.Write((byte)0);
                var certOffset = output.Position;
                writer.Write(new byte[16]);
                output.Position = 64 + 168;
                writer.Write((uint)certOffset); writer.Write((uint)16);
            }
        }
        return InstallerPackage.Open(exe);
    }
    public void Dispose() => Directory.Delete(Root, true);
}
