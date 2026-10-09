using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Media;
using Astella.Setup.Core;
using Microsoft.Win32;

namespace Astella.Setup;

public partial class MainWindow : Window
{
    private readonly InstallEngine engine;
    private InstallerOptions options;
    private bool busy;
    private string page = "notice";

    internal MainWindow(InstallEngine engine, InstallerOptions options, InstalledInstallation? registered)
    {
        this.engine = engine;
        this.options = options;
        InitializeComponent();
        UsageText.Text = ReadResource("usage");
        LicenseText.Text = ReadResource("license");
        VersionText.Text = Program.Package is null ? "应用与本机资料" : "v" + Program.Package.Manifest.Version;
        InstallDirectory.Text = options.InstallDirectory;
        CreateDesktopShortcut.IsChecked = registered?.DesktopShortcut ?? options.DesktopShortcut;
        if (registered != null)
        {
            InstallDirectory.IsReadOnly = true;
            BrowseButton.IsEnabled = false;
            CreateDesktopShortcut.IsEnabled = !options.Update;
            LocationHint.Text = "沿用现有安装位置并保留本机资料。如需移动，请先卸载，保持本机资料不清除，再重新安装。";
        }
        else LocationHint.Text = $"仅安装给当前用户 · 程序预计占用 {Math.Ceiling(Program.Package!.Manifest.Size / 1024d / 1024d)} MB\n请选择你有写入权限的独立文件夹。";
        if (options.Uninstall)
        {
            StepOne.Text = "01   保留你的选择";
            StepTwo.Text = "02   收起书房";
            StepThree.Text = "03   下次再见";
            UninstallDirectoryText.Text = "程序位置：" + options.InstallDirectory;
            ShowPage("uninstall");
        }
        else if (options.Update && registered?.LicenseId == Identity.LicenseId)
            Loaded += async (_, _) => await RunOperation();
        else if (options.Update) NoticeTitle.Text = "更新前，认识新的约定";
        Closing += OnClosing;
        Loaded += (_, _) =>
        {
            var work = SystemParameters.WorkArea;
            MinWidth = Math.Min(MinWidth, work.Width - 32);
            MinHeight = Math.Min(MinHeight, work.Height - 32);
            Width = Math.Min(Width, work.Width - 32);
            Height = Math.Min(Height, work.Height - 32);
            Left = work.Left + (work.Width - Width) / 2;
            Top = work.Top + (work.Height - Height) / 2;
            BookIllustration.Visibility = Height < 600 ? Visibility.Collapsed : Visibility.Visible;
        };
    }

    private static string ReadResource(string name)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream($"Astella.Setup.{name}.txt")!;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    private void ShowPage(string next)
    {
        page = next;
        foreach (var panel in new[] { NoticePanel, LocationPanel, ProgressPanel, UninstallPanel, DonePanel }) panel.Visibility = Visibility.Collapsed;
        (next switch { "notice" => NoticePanel, "location" => LocationPanel, "uninstall" => UninstallPanel, "done" => DonePanel, _ => ProgressPanel }).Visibility = Visibility.Visible;
        LicensePanel.Visibility = Visibility.Collapsed;
        NoticePanel.IsEnabled = true;
        ErrorText.Visibility = Visibility.Collapsed;
        BackButton.Visibility = next == "location" ? Visibility.Visible : Visibility.Collapsed;
        PrimaryButton.Content = next switch { "location" => options.Update ? "安装更新" : "开始安装", "uninstall" => "卸载应用", "progress" => "请稍候", "done" => options.Uninstall ? "完成" : "打开书房", _ => "继续" };
        PrimaryButton.IsEnabled = next != "progress" && (next != "notice" || AcceptNotice.IsChecked == true);
        StepOne.Foreground = new SolidColorBrush(next is "notice" or "uninstall" ? Color.FromRgb(48, 76, 67) : Color.FromRgb(123, 149, 136));
        StepTwo.Foreground = new SolidColorBrush(next is "location" or "progress" ? Color.FromRgb(48, 76, 67) : Color.FromRgb(123, 149, 136));
        StepThree.Foreground = new SolidColorBrush(next == "done" ? Color.FromRgb(48, 76, 67) : Color.FromRgb(123, 149, 136));
        if (next == "location") InstallDirectory.Focus();
        else if (next != "progress") PrimaryButton.Focus();
    }

    private async void Primary_Click(object sender, RoutedEventArgs e)
    {
        if (busy || LicensePanel.Visibility == Visibility.Visible) return;
        if (page == "notice") { if (AcceptNotice.IsChecked == true) ShowPage("location"); return; }
        if (page == "done")
        {
            try { if (!options.Uninstall) Program.Launch(options.InstallDirectory!); Close(); }
            catch (Exception error) { ShowError(error); }
            return;
        }
        await RunOperation();
    }

    private async Task RunOperation()
    {
        if (busy) return;
        options = options with { InstallDirectory = InstallDirectory.Text.Trim(), DesktopShortcut = CreateDesktopShortcut.IsChecked == true,
            DeleteData = options.Uninstall && DeleteLocalData.IsChecked == true };
        var retryPage = options.Uninstall ? "uninstall" : "location";
        busy = true;
        CloseButton.IsEnabled = false;
        ShowPage("progress");
        ProgressTitle.Text = options.Uninstall ? "正在收起书房" : options.Update ? "正在为书房更新" : "正在安放你的书房";
        InstallProgressBar.Value = 0;
        var progress = new Progress<InstallProgress>(value =>
        {
            InstallProgressBar.Value = value.Fraction * 100;
            ProgressPercent.Text = Math.Round(value.Fraction * 100) + "%";
            ProgressMessage.Text = value.Message;
        });
        try
        {
            // ZIP hashing and extraction stay off the UI thread; registry/COM uses an STA worker.
            await RunSta(async () =>
            {
                if (options.Uninstall) await engine.Uninstall(options, progress);
                else await engine.Install(Program.Package!, options, progress);
            });
            ShowPage("done");
            if (options.Uninstall)
            {
                DoneTitle.Text = "书房已收起";
                DoneMessage.Text = options.DeleteData ? "应用和默认本机资料已移除。你账号里的笔记仍然保留。" : "本机资料仍在原处。下次安装时，再带它们回到书房。";
            }
            else if (options.Update && options.Launch) { Program.Launch(options.InstallDirectory!); CloseAfterOperation = true; }
        }
        catch (Exception error) { Program.RecordFailure(options, error); ShowPage(retryPage); ShowError(error); }
        finally { busy = false; CloseButton.IsEnabled = true; if (CloseAfterOperation) Close(); }
    }

    private bool CloseAfterOperation;
    private static Task RunSta(Func<Task> action)
    {
        var result = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var worker = new Thread(() => { try { action().GetAwaiter().GetResult(); result.SetResult(); } catch (Exception error) { result.SetException(error); } });
        worker.SetApartmentState(ApartmentState.STA);
        worker.IsBackground = true;
        worker.Start();
        return result.Task;
    }
    private void ShowError(Exception error) { ErrorText.Text = error.Message; ErrorText.Visibility = Visibility.Visible; }
    private void Acceptance_Changed(object sender, RoutedEventArgs e) { if (PrimaryButton != null && page == "notice") PrimaryButton.IsEnabled = AcceptNotice.IsChecked == true && LicensePanel.Visibility != Visibility.Visible; }
    private void Directory_Changed(object sender, System.Windows.Controls.TextChangedEventArgs e) { if (ErrorText != null) ErrorText.Visibility = Visibility.Collapsed; }
    private void Browse_Click(object sender, RoutedEventArgs e)
    {
        var picker = new OpenFolderDialog { Title = "选择书房所在文件夹", Multiselect = false };
        if (Directory.Exists(InstallDirectory.Text)) picker.InitialDirectory = InstallDirectory.Text;
        if (picker.ShowDialog(this) == true) InstallDirectory.Text = Path.GetFileName(picker.FolderName).Equals("Astella", StringComparison.OrdinalIgnoreCase) ? picker.FolderName : Path.Combine(picker.FolderName, "Astella");
    }
    private void Back_Click(object sender, RoutedEventArgs e) => ShowPage("notice");
    private void License_Click(object sender, RoutedEventArgs e) { LicensePanel.Visibility = Visibility.Visible; NoticePanel.IsEnabled = false; PrimaryButton.IsEnabled = false; LicenseText.Focus(); }
    private void CloseLicense_Click(object sender, RoutedEventArgs e) { LicensePanel.Visibility = Visibility.Collapsed; NoticePanel.IsEnabled = true; PrimaryButton.IsEnabled = AcceptNotice.IsChecked == true; AcceptNotice.Focus(); }
    private void Minimize_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void Close_Click(object sender, RoutedEventArgs e) => Close();
    private void OnClosing(object? sender, CancelEventArgs e) { if (busy) e.Cancel = true; }
}
