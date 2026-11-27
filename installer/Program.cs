using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
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
    private readonly Button prepare = new Button { Text = "准备安装", AutoSize = true };
    private readonly Button finish = new Button { Text = "已完成安装", AutoSize = true, Enabled = false };
    private readonly Button copy = new Button { Text = "复制路径", AutoSize = true, Enabled = false };
    private readonly TextBox installPath = new TextBox { ReadOnly = true, Dock = DockStyle.Fill };
    private readonly Label status = new Label { AutoSize = true, MaximumSize = new Size(530, 0) };
    private readonly string edgeExe = FindBrowser("msedge.exe", @"Microsoft\Edge\Application");
    private readonly string chromeExe = FindBrowser("chrome.exe", @"Google\Chrome\Application");

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
        Add(layout, new Label { Text = "选择浏览器。准备完成后，在扩展页开启开发人员模式，点「加载解压缩的扩展」，然后粘贴下方路径。", AutoSize = true, MaximumSize = new Size(530, 0) });

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

    private void Prepare()
    {
        try
        {
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "makelifeasier", "ChaoxingCourseware");
            Directory.CreateDirectory(root);
            var stage = Path.Combine(root, "setup-" + Guid.NewGuid().ToString("N"));
            using (var zip = Program.ReadPackage()) zip.ExtractToDirectory(stage);
            var staged = Path.Combine(stage, "extension");
            if (!File.Exists(Path.Combine(staged, "manifest.json"))) throw new IOException("安装包缺少 manifest.json。");
            // A stable directory keeps the unpacked extension ID and its local data across updates.
            var destination = Path.Combine(root, "extension");
            Directory.CreateDirectory(destination);
            foreach (var file in Directory.GetFiles(staged, "*", SearchOption.AllDirectories))
            {
                var target = Path.Combine(destination, file.Substring(staged.Length + 1));
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                File.Copy(file, target, true);
            }
            Directory.Delete(stage, true);
            installPath.Text = destination;
            copy.Enabled = true;
            finish.Enabled = true;
            CopyPath();
            var failures = "";
            if (edge.Checked && !OpenBrowser(edgeExe, "edge://extensions/")) failures += " Edge";
            if (chrome.Checked && !OpenBrowser(chromeExe, "chrome://extensions/")) failures += " Chrome";
            status.Text = failures.Length == 0
                ? "已准备文件。请在所选浏览器确认加载。已用此助手安装过的，可在扩展页点「重新加载」。"
                : "文件已准备。以下浏览器未自动打开，请手动打开扩展页：" + failures;
        }
        catch (Exception error)
        {
            status.Text = "准备失败。 " + error.Message;
        }
    }

    private void CopyPath()
    {
        try { Clipboard.SetText(installPath.Text); }
        catch { status.Text = "剪贴板正忙，请手动复制路径框里的内容。"; }
    }

    private static bool OpenBrowser(string exe, string url)
    {
        try { Process.Start(new ProcessStartInfo(exe, url) { UseShellExecute = false }); return true; }
        catch { return false; }
    }

    private void Finish()
    {
        if (cleanup.Checked)
        {
            try { ScheduleCleanup(); }
            catch (Exception error) { status.Text = "安装器未能自动删除，可手动删除。 " + error.Message; return; }
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
        var script = "$ErrorActionPreference='Stop'\n" +
                     "Wait-Process -Id " + Process.GetCurrentProcess().Id + " -Timeout 20 -ErrorAction SilentlyContinue\n" +
                     "$installer=" + literal + "\n" +
                     "if ((Test-Path -LiteralPath $installer -PathType Leaf) -and (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -eq '" + digest + "') {" +
                     " Remove-Item -LiteralPath $installer -Force }";
        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        var powershell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
        Process.Start(new ProcessStartInfo(powershell, "-NoProfile -NonInteractive -EncodedCommand " + encoded) {
            UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden
        });
    }
}
