using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("超星课件下载安装助手")]
[assembly: AssemblyCompany("makelifeasier")]
[assembly: AssemblyProduct("超星课件下载")]

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--verify-package")
        {
            using (var archive = ReadPackage())
                return archive.GetEntry("extension/manifest.json") != null &&
                       archive.GetEntry("extension/manager.js") != null ? 0 : 1;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Installer());
        return 0;
    }

    internal static ZipArchive ReadPackage()
    {
        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("extension.zip");
        return new ZipArchive(stream, ZipArchiveMode.Read);
    }
}

internal sealed class Installer : Form
{
    private readonly CheckBox edge = new CheckBox { Text = "Microsoft Edge", AutoSize = true };
    private readonly CheckBox chrome = new CheckBox { Text = "Google Chrome", AutoSize = true };
    private readonly CheckBox cleanup = new CheckBox { Text = "完成后删除这个安装器", AutoSize = true };
    private readonly Button prepare = new Button { Text = "安装", AutoSize = true };
    private readonly Button finish = new Button { Text = "已完成安装", AutoSize = true, Enabled = false };
    private readonly Button copy = new Button { Text = "复制路径", AutoSize = true, Enabled = false };
    private readonly TextBox installPath = new TextBox { ReadOnly = true, Dock = DockStyle.Fill };
    private readonly Label status = new Label { AutoSize = true, MaximumSize = new Size(530, 0) };
    private readonly string edgeExe = FindBrowser("msedge.exe", @"Microsoft\Edge\Application");
    private readonly string chromeExe = FindBrowser("chrome.exe", @"Google\Chrome\Application");
    private CancellationTokenSource installation;

    internal Installer()
    {
        Text = "超星课件下载 · 安装助手";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(580, 405);
        MinimumSize = new Size(480, 440);
        AutoScaleMode = AutoScaleMode.Font;
        Font = new Font("Microsoft YaHei UI", 10);
        BackColor = Color.White;
        ForeColor = Color.FromArgb(31, 43, 62);

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), ColumnCount = 1, AutoScroll = true };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Controls.Add(layout);
        Add(layout, new Label { Text = "超星课件下载", AutoSize = true, Font = new Font(Font.FontFamily, 20, FontStyle.Bold) });
        var author = new LinkLabel { Text = "GitHub / @makelifeasier", AutoSize = true };
        author.LinkClicked += delegate { Process.Start("https://github.com/makelifeasier/chaoxing-courseware"); };
        Add(layout, author);
        Add(layout, new Label { Text = "勾选浏览器后点击「安装」。首次使用时，按提示在浏览器中开启开发人员模式，助手会自动继续。", AutoSize = true, MaximumSize = new Size(530, 0) });

        edge.Enabled = edgeExe != null;
        chrome.Enabled = chromeExe != null;
        edge.Checked = edge.Enabled;
        chrome.Checked = !edge.Enabled && chrome.Enabled;
        if (!edge.Enabled) edge.Text += "（未找到）";
        if (!chrome.Enabled) chrome.Text += "（未找到）";
        Add(layout, Row(edge, chrome));
        Add(layout, cleanup);
        var pathRow = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, Dock = DockStyle.Top };
        pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        pathRow.Controls.Add(installPath);
        pathRow.Controls.Add(copy);
        Add(layout, pathRow);
        prepare.BackColor = Color.FromArgb(31, 88, 180);
        prepare.ForeColor = Color.White;
        prepare.FlatStyle = FlatStyle.Flat;
        prepare.Enabled = edge.Checked || chrome.Checked;
        Add(layout, Row(prepare, finish));
        status.Text = "文件随安装器提供，解压到当前用户的应用数据文件夹，无需管理员权限。";
        Add(layout, status);

        edge.CheckedChanged += delegate { prepare.Enabled = edge.Checked || chrome.Checked; };
        chrome.CheckedChanged += delegate { prepare.Enabled = edge.Checked || chrome.Checked; };
        prepare.Click += delegate { Prepare(); };
        copy.Click += delegate { CopyPath(); };
        finish.Click += delegate { Finish(); };
    }

    private static FlowLayoutPanel Row(params Control[] controls)
    {
        var panel = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top };
        panel.Controls.AddRange(controls);
        return panel;
    }

    private static void Add(TableLayoutPanel panel, Control control)
    {
        control.Margin = new Padding(0, 0, 0, 10);
        panel.Controls.Add(control);
    }

    private static string FindBrowser(string exe, string folder)
    {
        foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using (var key = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\" + exe))
            {
                var path = key == null ? null : key.GetValue(null) as string;
                if (File.Exists(path)) return path;
            }
        }
        foreach (var root in new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.LocalApplicationData })
        {
            var path = Path.Combine(Environment.GetFolderPath(root), folder, exe);
            if (File.Exists(path)) return path;
        }
        return null;
    }

    private async void Prepare()
    {
        var useEdge = edge.Checked;
        var useChrome = chrome.Checked;
        var run = new CancellationTokenSource();
        installation = run;
        prepare.Enabled = edge.Enabled = chrome.Enabled = finish.Enabled = false;
        cleanup.Enabled = false;
        try
        {
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "makelifeasier", "ChaoxingCourseware");
            string destination;
            using (var zip = Program.ReadPackage()) destination = ExtensionFiles.Install(root, zip);
            installPath.Text = destination;
            copy.Enabled = true;
            status.Text = "正在打开浏览器扩展页…";
            var results = new List<string>();
            var allInstalled = true;
            const string edgePage = "edge://extensions/";
            const string chromePage = "chrome://extensions/";
            if (useEdge)
            {
                var result = await GuideBrowser("Edge", edgeExe, edgePage, destination, run.Token);
                results.Add("Edge · " + Describe(result, edgePage));
                allInstalled &= result == BrowserGuide.Result.Installed;
            }
            if (useChrome)
            {
                run.Token.ThrowIfCancellationRequested();
                status.Text = "正在打开 Chrome 扩展页…";
                var result = await GuideBrowser("Chrome", chromeExe, chromePage, destination, run.Token);
                results.Add("Chrome · " + Describe(result, chromePage));
                allInstalled &= result == BrowserGuide.Result.Installed;
            }
            status.Text = string.Join(Environment.NewLine, results);
            if (allInstalled)
            {
                MessageBox.Show(status.Text, "安装成功", MessageBoxButtons.OK, MessageBoxIcon.Information);
                Finish();
                return;
            }
            Show();
            Activate();
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            if (!IsDisposed)
            {
                status.Text = "安装失败。 " + error.Message;
                Show();
            }
        }
        finally
        {
            installation = null;
            run.Dispose();
            if (!IsDisposed)
            {
                edge.Enabled = edgeExe != null;
                chrome.Enabled = chromeExe != null;
                prepare.Enabled = edge.Checked || chrome.Checked;
                finish.Enabled = installPath.Text.Length != 0;
                cleanup.Enabled = true;
            }
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        base.OnFormClosing(e);
        if (!e.Cancel && installation != null) installation.Cancel();
    }

    private Task<BrowserGuide.Result> GuideBrowser(string name, string exe, string page, string folder,
        CancellationToken cancellation)
    {
        var start = BrowserGuide.NewWindow(exe);
        IProgress<bool> guide = new Progress<bool>(waiting =>
        {
            if (IsDisposed || cancellation.IsCancellationRequested) return;
            if (!waiting)
            {
                Hide();
                return;
            }
            var location = name == "Edge" ? "扩展页左侧（窄窗口先展开「扩展」菜单）" : "扩展页右上角";
            status.Text = "请切到 " + name + "，在" + location + "开启「开发人员模式」。" +
                Environment.NewLine + "开启后自动继续，最多等待 90 秒。";
            Show();
        });
        return Task.Run(() =>
        {
            try
            {
                return BrowserGuide.Open(start, page, folder, guide.Report, cancellation).Install(page, folder, cancellation);
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception error)
            {
                Debug.WriteLine(error);
                return BrowserGuide.Result.Unverified;
            }
        });
    }

    private void CopyPath()
    {
        try { Clipboard.SetText(installPath.Text); }
        catch { status.Text = "剪贴板正忙，请手动复制路径框里的内容。"; }
    }

    private static string Describe(BrowserGuide.Result result, string page)
    {
        switch (result)
        {
            case BrowserGuide.Result.Installed:
                return "安装成功";
            case BrowserGuide.Result.Unverified:
                return "未能核对安装结果，请在 " + page + " 查看扩展和浏览器提示。";
            case BrowserGuide.Result.DeveloperModeTimedOut:
                return "等待开发人员模式超时。请在 " + page + " 开启后重试；若开关不可用，请查看浏览器的管理提示。";
            case BrowserGuide.Result.PickerOpen:
                return "请将上方路径粘贴到文件夹窗口的地址栏，回车后选择文件夹。";
            case BrowserGuide.Result.OpenFailed:
                return "请打开 " + page + "，用上方路径加载扩展。";
            case BrowserGuide.Result.WindowUnavailable:
                return "未找到新浏览器窗口。请先打开浏览器并处理首次启动或选用户的提示，再重试。";
            case BrowserGuide.Result.PageUnavailable:
                return "浏览器已打开，但未能进入扩展页。请在地址栏打开 " + page + "，用上方路径手动加载。";
            default:
                return "在 " + page + " 打开开发人员模式，点「加载解压缩的扩展」，再粘贴上方路径。";
        }
    }

    private void Finish()
    {
        if (cleanup.Checked)
        {
            try { ScheduleCleanup(); }
            catch (Exception error) { status.Text = "安装器未能自动删除，可手动删除。 " + error.Message; Show(); Activate(); return; }
        }
        Close();
    }

    private static void ScheduleCleanup()
    {
        var file = Application.ExecutablePath;
        string digest;
        using (var stream = File.OpenRead(file))
        using (var sha = SHA256.Create()) digest = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "");
        var literal = "'" + file.Replace("'", "''") + "'";
        string waitForExit;
        using (var current = Process.GetCurrentProcess())
            waitForExit = "try { $p=[Diagnostics.Process]::GetProcessById(" + current.Id + ") } catch [ArgumentException] { $p=$null }\n" +
                          "if ($p) { try { if ($p.StartTime.ToFileTimeUtc() -eq " + current.StartTime.ToFileTimeUtc() +
                          " -and -not $p.WaitForExit(20000)) { throw '等待安装器退出超时。' } } finally { $p.Dispose() } }\n";
        var script = "$ErrorActionPreference='Stop'\ntry {\n" + waitForExit +
                     "$installer=" + literal + "\n" +
                     "if ([IO.File]::Exists($installer)) {\n" +
                     "  $file=[IO.File]::OpenRead($installer); $sha=[Security.Cryptography.SHA256]::Create()\n" +
                     "  try { $hash=[BitConverter]::ToString($sha.ComputeHash($file)).Replace('-','') } finally { $file.Dispose(); $sha.Dispose() }\n" +
                     "  if ($hash -eq '" + digest + "') { [IO.File]::Delete($installer) }\n" +
                     "}\n} catch {\n" +
                     "  [void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')\n" +
                     "  [void][Windows.Forms.MessageBox]::Show('未能自动删除安装器，可手动删除。','超星课件下载')\n" +
                     "  exit 1\n}";
        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        var powershell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
        using (Process.Start(new ProcessStartInfo(powershell, "-NoProfile -NonInteractive -EncodedCommand " + encoded) {
            UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden
        })) { }
    }
}
