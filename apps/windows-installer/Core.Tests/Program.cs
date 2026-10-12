using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using Astella.Setup.Core;

// Run separately as an unprivileged Unix user to exercise real filesystem refusals.
if (args.SequenceEqual(new[] { "--verify-write-fallback" }) && !OperatingSystem.IsWindows())
{
    await VerifyUnixWrites();
    return;
}

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
        Assert(install.Installation.InstallDirectory == f.Target && install.OldProgramDirectory is null
            && File.Exists(Path.Combine(f.Target, Identity.Uninstaller)));
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
        f.AssertNoWorkspaces();
    }),
    ("ZIP traversal and symlink entries cannot write outside staging", async f =>
    {
        await Reject(() => f.Engine.Install(f.Package(path: "../escape"), f.Options));
        await Reject(() => f.Engine.Install(f.Package(symlink: true), f.Options));
        Assert(!Directory.Exists(f.Target) && !File.Exists(Path.Combine(f.Root, "escape")));
        f.AssertNoWorkspaces();
    }),
    ("cancelled preparation leaves existing program and profile untouched", async f =>
    {
        await f.Engine.Install(f.Package("1.0.0"), f.Options);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Reject(() => f.Engine.Install(f.Package("2.0.0"), f.Options, cancel: cancellation.Token));
        Assert(f.Registry.Current!.Version == "1.0.0" && File.ReadAllText(f.Draft) == "unsynced draft");
        f.AssertNoWorkspaces();
    }),
    ("cancellation after extraction cleans staging and leaves the old version intact", async f =>
    {
        await f.Engine.Install(f.Package(), f.Options);
        using var cancellation = new CancellationTokenSource();
        var progress = new ImmediateProgress(value => { if (value.Fraction == 0.85) cancellation.Cancel(); });
        await Reject(() => f.Engine.Install(f.Package("2.0.0"), f.Options, progress, cancellation.Token));
        Assert(f.Registry.Current!.Version == "1.0.0" && File.ReadAllText(f.Draft) == "unsynced draft");
        f.AssertNoWorkspaces();
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
    ("wrong target version and overlapping relocation directories are rejected", async f =>
    {
        await f.Engine.Install(f.Package(), f.Options);
        await Reject(() => f.Engine.Install(f.Package(), f.Options with { TargetVersion = "9.0.0" }));
        foreach (var target in new[] { Path.Combine(f.Target, "nested"), Path.GetDirectoryName(f.Target)! })
            await Reject(() => f.Engine.Install(f.Package(), f.Options with { Update = true, InstallDirectory = target }));
        Assert(f.Registry.Current!.InstallDirectory == f.Target);
    }),
    ("reinstall at a new location updates registration and removes the old program, retaining drafts", async f =>
    {
        await f.Engine.Install(f.Package(), f.Options);
        var target = Path.Combine(f.Root, "新位置", "Astella");
        var result = await f.Engine.Install(f.Package("2.0.0"), f.Options with { InstallDirectory = target, DesktopShortcut = false });
        Assert(result.Installation.InstallDirectory == target && result.OldProgramDirectory is null);
        Assert(f.Registry.Current!.InstallDirectory == target && !f.Registry.Current.DesktopShortcut);
        Assert(!Directory.Exists(f.Target) && File.ReadAllText(f.Draft) == "unsynced draft");
        await f.Engine.Uninstall(f.Options with { InstallDirectory = target, Uninstall = true });
        Assert(f.Registry.Current is null && File.Exists(f.Draft));
        f.AssertNoWorkspaces();
    }),
    ("update relocation preserves shortcut preferences and progress finishes at 100 percent", async f =>
    {
        await f.Engine.Install(f.Package(), f.Options with { DesktopShortcut = false });
        var target = Path.Combine(f.Root, "elsewhere");
        var values = new List<double>();
        await f.Engine.Install(f.Package("2.0.0"), f.Options with { Update = true, InstallDirectory = target },
            new ImmediateProgress(value => values.Add(value.Fraction)));
        Assert(f.Registry.Current!.InstallDirectory == target && !f.Registry.Current.DesktopShortcut);
        Assert(!Directory.Exists(f.Target) && values[^1] == 1);
        Assert(values.SequenceEqual(values.Order()));
    }),
    ("legacy installation can move without invoking its uninstaller", async f =>
    {
        Directory.CreateDirectory(f.Target);
        File.WriteAllText(Path.Combine(f.Target, Identity.Executable), "legacy");
        f.Registry.Current = new(Identity.AppId, "legacy", f.Target, true, [], "");
        var target = Path.Combine(f.Root, "elsewhere");
        await f.Engine.Install(f.Package("2.0.0"), f.Options with { InstallDirectory = target });
        Assert(f.Registry.Current!.InstallDirectory == target && !Directory.Exists(f.Target) && File.Exists(f.Draft));
    }),
    ("partial registration failure during relocation restores the original registration and program", async f =>
    {
        await f.Engine.Install(f.Package(), f.Options);
        var target = Path.Combine(f.Root, "elsewhere");
        f.Registry.FailNextRegister = true;
        await Reject(() => f.Engine.Install(f.Package("2.0.0"), f.Options with { InstallDirectory = target }));
        Assert(f.Registry.Current!.InstallDirectory == f.Target && f.Registry.Current.Version == "1.0.0");
        Assert(File.ReadAllText(Path.Combine(f.Target, Identity.Executable)) == "app 1.0.0" && !Directory.Exists(target));
        Assert(File.ReadAllText(f.Draft) == "unsynced draft");
        f.AssertNoWorkspaces();
    }),
    ("relocation rollback restores an occupied Astella target and the actual registered location", async f =>
    {
        await f.Engine.Install(f.Package(), f.Options);
        var target = Path.Combine(f.Root, "elsewhere");
        await new InstallEngine(new FakeRegistration(), f.Profile).Install(f.Package("0.9.0"), f.Options with { InstallDirectory = target });
        f.Registry.FailNextRegister = true;
        await Reject(() => f.Engine.Install(f.Package("2.0.0"), f.Options with { InstallDirectory = target }));
        Assert(f.Registry.Current!.InstallDirectory == f.Target && f.Registry.Current.Version == "1.0.0");
        Assert(File.ReadAllText(Path.Combine(target, Identity.Executable)) == "app 0.9.0" && File.Exists(f.Draft));
        f.AssertNoWorkspaces();
    }),
    ("a protected old location is retained and reported without turning a successful install into failure", async f =>
    {
        File.WriteAllText(Path.Combine(f.Profile, Identity.Executable), "legacy");
        f.Registry.Current = new(Identity.AppId, "legacy", f.Profile, true, [], "");
        var result = await f.Engine.Install(f.Package(), f.Options);
        Assert(result.OldProgramDirectory == f.Profile && f.Registry.Current!.InstallDirectory == f.Target);
        Assert(File.Exists(f.Draft) && File.Exists(Path.Combine(f.Profile, Identity.Executable)));
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

if (OperatingSystem.IsWindows()) await VerifyWindows();

[System.Runtime.Versioning.SupportedOSPlatform("windows")]
static async Task VerifyWindows()
{
    using (var fileFixture = new Fixture())
    {
        var staging = Path.Combine(fileFixture.Root, "locked-staging");
        Directory.CreateDirectory(staging);
        var dll = Path.Combine(staging, "d3dcompiler_47.dll");
        var package = fileFixture.Package();
        using (var locked = new FileStream(dll, FileMode.Create, FileAccess.ReadWrite, FileShare.None))
        {
            var extraction = package.Extract(staging, null, default);
            await Task.Delay(350);
            locked.Dispose();
            await extraction;
        }
        Assert(File.ReadAllText(dll) == "dll");
        Console.WriteLine("PASS transient DLL sharing violation retries the complete file and verifies its hash");

        File.SetAttributes(dll, FileAttributes.ReadOnly);
        try
        {
            try
            {
                await package.Extract(staging, null, default);
                throw new Exception("Expected a persistent write refusal");
            }
            catch (WriteDeniedException error)
            {
                Assert(error.Path == dll && error.InnerException is UnauthorizedAccessException);
                Assert(!error.Message.Contains("压缩包已经写进去了"));
            }
        }
        finally { File.SetAttributes(dll, FileAttributes.Normal); }
        Console.WriteLine("PASS persistent DLL access denial retains its cause and gives an actionable message");
    }
    using var fixture = new Fixture();
    Directory.CreateDirectory(fixture.Target);
    var executable = Path.Combine(fixture.Target, Identity.Executable);
    File.WriteAllText(executable, "shortcut target");
    var shortcut = Path.Combine(fixture.Root, "快捷方式 中文 ' 空格.lnk");
    Astella.Setup.WindowsShortcut.Create(shortcut, executable);
    Assert(File.Exists(shortcut));
    Assert(Astella.Setup.WindowsShortcut.ReadTarget(shortcut).Equals(executable, InstallPaths.Comparison));
    Astella.Setup.WindowsShortcut.DeleteIfOwned(shortcut, Path.Combine(fixture.Root, "other app"));
    Assert(File.Exists(shortcut));
    Astella.Setup.WindowsShortcut.DeleteIfOwned(shortcut, fixture.Target);
    Assert(!File.Exists(shortcut));
    Console.WriteLine("PASS native Windows shortcut round trip; Chinese, spaces and apostrophe paths; preserve foreign targets");
}

static void Assert(bool condition) { if (!condition) throw new Exception("Assertion failed"); }
static void AssertThrows(Action action) { try { action(); } catch { return; } throw new Exception("Expected rejection"); }
static async Task Reject(Func<Task> action) { try { await action(); } catch { return; } throw new Exception("Expected rejection"); }

[System.Runtime.Versioning.UnsupportedOSPlatform("windows")]
static async Task VerifyUnixWrites()
{
    using var fixture = new Fixture();
    var parent = Path.GetDirectoryName(fixture.Target)!;
    Directory.CreateDirectory(parent);
    var permissions = File.GetUnixFileMode(parent);
    File.SetUnixFileMode(parent, UnixFileMode.UserRead | UnixFileMode.UserExecute);
    try
    {
        try { Directory.CreateDirectory(Path.Combine(parent, "permission-probe")); throw new Exception("This check requires an unprivileged user"); }
        catch (UnauthorizedAccessException) { }
        var result = await fixture.Engine.Install(fixture.Package(), fixture.Options,
            new ImmediateProgress(value => { if (value.Fraction == 0.85 && !OperatingSystem.IsWindows()) File.SetUnixFileMode(parent, permissions); }));
        Assert(result.Installation.InstallDirectory == fixture.Target && File.Exists(fixture.Draft));
        fixture.AssertNoWorkspaces();
        Console.WriteLine("PASS real permission refusal selects another staging location and commits the verified files");
    }
    finally { File.SetUnixFileMode(parent, permissions); }

    var deniedStaging = Path.Combine(fixture.Root, "denied-staging");
    Directory.CreateDirectory(deniedStaging);
    permissions = File.GetUnixFileMode(deniedStaging);
    File.SetUnixFileMode(deniedStaging, UnixFileMode.UserRead | UnixFileMode.UserExecute);
    try
    {
        try { await fixture.Package().Extract(deniedStaging, null, default); throw new Exception("Expected a write refusal"); }
        catch (WriteDeniedException error)
        {
            Assert(error.InnerException is UnauthorizedAccessException && error.Path.EndsWith(".payload.zip"));
            Assert(!error.Message.Contains("压缩包已经写进去了"));
        }
        Console.WriteLine("PASS a refused archive write retains the real cause without claiming extraction had succeeded");
    }
    finally { File.SetUnixFileMode(deniedStaging, permissions); }
}

sealed class FakeRegistration : IInstallationRegistration
{
    public InstalledInstallation? Current;
    public bool FailNextRegister;
    public bool FailRemove;
    public InstalledInstallation? Read() => Current;
    public void Register(InstalledInstallation record)
    {
        // Windows writes registry values before creating shortcuts, so a failure can be partial.
        Current = record;
        if (FailNextRegister) { FailNextRegister = false; throw new IOException("registry failure"); }
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
    public void AssertNoWorkspaces()
    {
        if (Directory.EnumerateDirectories(Root, ".astella-*", SearchOption.AllDirectories).Any())
            throw new Exception("Preparation left a staging or backup directory behind");
    }
    public InstallerPackage Package(string version = "1.0.0", string? path = null, bool corruptZip = false,
        bool corruptFile = false, bool symlink = false, bool signed = false)
    {
        var zip = Path.Combine(Root, Guid.NewGuid() + ".zip");
        var files = new List<PackageFile>();
        using (var archive = ZipFile.Open(zip, ZipArchiveMode.Create))
        {
            foreach (var (name, content) in new[] { (path ?? Identity.Executable, "app " + version), (Identity.Uninstaller, "uninstaller"), ("d3dcompiler_47.dll", "dll"), ("resources/中文.txt", "resource") })
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

sealed class ImmediateProgress(Action<InstallProgress> report) : IProgress<InstallProgress>
{
    public void Report(InstallProgress value) => report(value);
}
