using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
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
    private string lastProgressMessage = "";

    internal MainWindow(InstallEngine engine, InstallerOptions options, InstalledInstallation? registered)
    {
        this.engine = engine;
        this.options = options;
        InitializeComponent();
        UsageText.Text = ReadResource("usage");
        LicenseText.Text = ReadResource("license");
        var package = Program.Package;
        VersionText.Text = package is null ? registered is null ? "应用与本机资料" : "v" + registered.Version
            : options.Update && registered != null ? $"v{registered.Version}  →  v{package.Manifest.Version}" : "v" + package.Manifest.Version;
        InstallDirectory.Text = options.InstallDirectory;
        CreateDesktopShortcut.IsChecked = registered?.DesktopShortcut ?? options.DesktopShortcut;
        if (registered != null)
        {
            InstallDirectory.IsReadOnly = true;
            BrowseButton.IsEnabled = false;
            CreateDesktopShortcut.IsEnabled = !options.Update;
            LocationHint.Text = "沿用现有安装位置并保留本机资料。如需移动，请先卸载，保持本机资料不清除，再重新安装。";
        }
        else
        {
            // 卸载器不携带包体，Program.Package 为空；登记记录也丢了的时候走到这里不能把界面带崩。
            var estimate = package is null ? "" : $"程序预计占用 {Math.Ceiling(package.Manifest.Size / 1024d / 1024d)} MB\n";
            LocationHint.Text = "仅安装给当前用户 · " + estimate + "请选择你有写入权限的独立文件夹。";
        }
        if (options.Uninstall)
        {
            OperationLabel.Text = "卸载应用";
            CoverCaption.Text = "想再回来时，\n书房随时为你打开。";
            StepOne.Text = "资料选择";
            StepTwo.Text = "移除应用";
            StepThree.Text = "下次再见";
            UninstallDirectoryText.Text = "程序位置：" + options.InstallDirectory;
        }
        else if (options.Update)
        {
            OperationLabel.Text = "安装更新";
            CoverCaption.Text = "熟悉的书房，\n带着新的可能回来。";
            StepOne.Text = "更新约定";
            StepTwo.Text = "安装更新";
            StepThree.Text = "回到书房";
            NoticeTitle.Text = "更新前，认识新的约定";
            LocationTitle.Text = "让书房焕然一新";
            LocationDescription.Text = "沿用现有位置，你的本机资料会完整保留。";
        }
        var automaticUpdate = options.Update && registered?.LicenseId == Identity.LicenseId;
        ShowPage(options.Uninstall ? "uninstall" : automaticUpdate ? "progress" : "notice");
        Closing += OnClosing;
        Loaded += async (_, _) =>
        {
            var work = SystemParameters.WorkArea;
            MinWidth = Math.Min(MinWidth, work.Width - 32);
            MinHeight = Math.Min(MinHeight, work.Height - 32);
            Width = Math.Min(Width, work.Width - 32);
            Height = Math.Min(Height, work.Height - 32);
            Left = work.Left + (work.Width - Width) / 2;
            Top = work.Top + (work.Height - Height) / 2;
            CoverColumn.Width = new GridLength(Width < 840 ? 208 : 240);
            CoverStory.Visibility = Height < 600 ? Visibility.Collapsed : Visibility.Visible;
            UsageScroller.Height = Math.Clamp(Height - 454, 100, 226);
            if (automaticUpdate) await RunOperation();
            else FocusPage();
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
        NoticeConsentPanel.Visibility = next == "notice" ? Visibility.Visible : Visibility.Collapsed;
        NoticePanel.IsEnabled = true;
        ErrorPanel.Visibility = Visibility.Collapsed;
        PageScroller.Visibility = Visibility.Visible;
        PageScroller.ScrollToTop();
        BackButton.Visibility = next == "location" ? Visibility.Visible : Visibility.Collapsed;
        PrimaryButton.Content = next switch { "location" => options.Update ? "安装更新" : "开始安装", "uninstall" => "卸载应用", "progress" => "请稍候", "done" => options.Uninstall ? "完成" : "打开书房", _ => "继续" };
        PrimaryButton.IsEnabled = next != "progress" && (next != "notice" || AcceptNotice.IsChecked == true);
        PageEyebrow.Text = next switch { "location" => options.Update ? "更新位置" : "安放书房", "uninstall" => "离开之前", "progress" => options.Uninstall ? "正在卸载" : options.Update ? "正在更新" : "正在安装", "done" => "一切就绪", _ => "开始之前" };
        FooterHint.Text = next == "progress" ? options.Update && options.Launch ? "完成后会自动打开书房" : "正在处理，请稍候"
            : options.Uninstall ? "账号与云端笔记始终保留" : options.Update ? "保留现有位置与本机资料" : "仅为当前 Windows 用户安装";
        var currentStep = next == "done" ? 2 : next is "location" or "progress" ? 1 : 0;
        var rows = new[] { StepOneRow, StepTwoRow, StepThreeRow };
        var labels = new[] { StepOne, StepTwo, StepThree };
        var numbers = new[] { StepOneNumber, StepTwoNumber, StepThreeNumber };
        for (var i = 0; i < rows.Length; i++)
        {
            rows[i].Tag = i == currentStep ? "active" : i < currentStep ? "complete" : "upcoming";
            labels[i].Foreground = (Brush)FindResource(i == currentStep ? "Ink" : "MutedInk");
            labels[i].FontWeight = i == currentStep ? FontWeights.SemiBold : FontWeights.Normal;
            numbers[i].Text = i < currentStep ? "✓" : (i + 1).ToString("00");
        }
        UpdateDataChoice();
        FocusPage();
    }

    private void FocusPage()
    {
        if (page == "notice") UsageScroller.Focus();
        else if (page == "location") InstallDirectory.Focus();
        else if (page != "progress") PrimaryButton.Focus();
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
        ProgressDescription.Text = options.Uninstall ? options.DeleteData ? "移除应用，并清除默认本机资料。" : "移除应用，把本机资料留在原处。"
            : options.Update ? "更新程序，你的笔记和本机资料会保留。" : "把程序放好，再为你准备好书房入口。";
        System.Windows.Automation.AutomationProperties.SetName(InstallProgressBar, options.Uninstall ? "卸载进度" : options.Update ? "更新进度" : "安装进度");
        InstallProgressBar.Value = 0;
        ProgressPercent.Text = "0%";
        SetProgressMessage("正在准备文件");
        var progress = new Progress<InstallProgress>(value =>
        {
            InstallProgressBar.Value = value.Fraction * 100;
            ProgressPercent.Text = Math.Round(value.Fraction * 100) + "%";
            SetProgressMessage(value.Message);
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
                DoneDetail.Text = options.DeleteData ? "外部导出文件与云端内容没有被删除。" : "保留位置：%APPDATA%\\astella-desktop-client";
            }
            else
            {
                DoneTitle.Text = options.Update ? "书房更新好了" : "书房准备好了";
                DoneMessage.Text = options.Update ? "新的程序已经就位，接着上次的想法继续吧。" : "带上一颗好奇心，开始今天的学习。";
                DoneDetail.Text = "程序位置：" + options.InstallDirectory;
                if (options.Update && options.Launch) { Program.Launch(options.InstallDirectory!); CloseAfterOperation = true; }
            }
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
    private void ShowError(Exception error) { ErrorText.Text = error.Message; ErrorPanel.Visibility = Visibility.Visible; Announce(ErrorText); }
    private void Acceptance_Changed(object sender, RoutedEventArgs e) { if (PrimaryButton != null && page == "notice") PrimaryButton.IsEnabled = AcceptNotice.IsChecked == true && LicensePanel.Visibility != Visibility.Visible; }
    private void Directory_Changed(object sender, TextChangedEventArgs e) { if (ErrorPanel != null) ErrorPanel.Visibility = Visibility.Collapsed; }
    private void DataChoice_Changed(object sender, RoutedEventArgs e) => UpdateDataChoice();
    // LiveSetting 只是声明；WPF 不会自己发 LiveRegionChanged，屏幕阅读器收到这条事件才会播报。
    private void SetProgressMessage(string message)
    {
        if (message == lastProgressMessage) return;
        lastProgressMessage = message;
        ProgressMessage.Text = message;
        Announce(ProgressMessage);
    }
    private static void Announce(UIElement element)
    {
        try { (UIElementAutomationPeer.FromElement(element) ?? UIElementAutomationPeer.CreatePeerForElement(element))?.RaiseAutomationEvent(AutomationEvents.LiveRegionChanged); }
        catch (Exception) { } // 播报失败不能影响安装本身。
    }
    private void UpdateDataChoice()
    {
        var deleting = DeleteLocalData.IsChecked == true;
        var warningWasHidden = DeleteDataWarning.Visibility != Visibility.Visible;
        DeleteDataWarning.Visibility = deleting ? Visibility.Visible : Visibility.Collapsed;
        if (deleting && warningWasHidden) Announce(DeleteDataWarningText);
        DataChoiceTitle.Text = deleting ? "应用与本机资料，一起清除" : "本机资料，留在原处";
        DataChoiceHint.Text = deleting ? "移除默认资料目录中的草稿、登录状态、缓存与语音模型。" : "默认保留草稿、登录状态、缓存与语音模型，\n下次安装可以接着使用。";
        if (page == "uninstall") PrimaryButton.Content = deleting ? "卸载并清除资料" : "卸载应用";
    }
    private void Browse_Click(object sender, RoutedEventArgs e)
    {
        var picker = new OpenFolderDialog { Title = "选择书房所在文件夹", Multiselect = false };
        if (Directory.Exists(InstallDirectory.Text)) picker.InitialDirectory = InstallDirectory.Text;
        if (picker.ShowDialog(this) == true) InstallDirectory.Text = Path.GetFileName(picker.FolderName).Equals("Astella", StringComparison.OrdinalIgnoreCase) ? picker.FolderName : Path.Combine(picker.FolderName, "Astella");
    }
    private void Back_Click(object sender, RoutedEventArgs e) => ShowPage("notice");
    private void License_Click(object sender, RoutedEventArgs e) { LicensePanel.Visibility = Visibility.Visible; PageScroller.Visibility = Visibility.Collapsed; NoticeConsentPanel.Visibility = Visibility.Collapsed; NoticePanel.IsEnabled = false; PrimaryButton.IsEnabled = false; PageEyebrow.Text = "阅读许可"; LicenseScroller.Focus(); }
    private void CloseLicense_Click(object sender, RoutedEventArgs e) { LicensePanel.Visibility = Visibility.Collapsed; PageScroller.Visibility = Visibility.Visible; NoticeConsentPanel.Visibility = Visibility.Visible; NoticePanel.IsEnabled = true; PrimaryButton.IsEnabled = AcceptNotice.IsChecked == true; PageEyebrow.Text = "开始之前"; AcceptNotice.Focus(); }
    private void Minimize_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void Close_Click(object sender, RoutedEventArgs e) => Close();
    private void OnClosing(object? sender, CancelEventArgs e) { if (busy) e.Cancel = true; }
}
