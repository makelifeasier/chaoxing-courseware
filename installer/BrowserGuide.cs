using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

internal static class BrowserGuide
{
    internal enum Result
    {
        OpenFailed, WindowUnavailable, PageUnavailable, Manual, DeveloperModeTimedOut,
        PickerOpen, FolderReady, Installed, Unverified
    }

    internal sealed class Attempt
    {
        internal readonly Result Result;
        private readonly IntPtr browser;
        private readonly IntPtr picker;

        internal Attempt(Result result, IntPtr browser, IntPtr picker)
        {
            Result = result;
            this.browser = browser;
            this.picker = picker;
        }

        internal bool PickerVisible
        {
            get { return picker != IntPtr.Zero && IsWindowVisible(picker) && GetAncestor(picker, 3) == browser; }
        }

        internal Result Install(string page, string folder, CancellationToken cancellation = default(CancellationToken))
        {
            cancellation.ThrowIfCancellationRequested();
            if (Result != Result.FolderReady) return Result;
            if (!PickerVisible) return Result.Unverified;

            var address = OpenPickerAddress(picker);
            var confirm = GetDlgItem(picker, 1);
            if (!SamePath(ReadValue(address), folder) || confirm == IntPtr.Zero || !PickerVisible)
                return Result.PickerOpen;

            cancellation.ThrowIfCancellationRequested();
            if (!PostMessage(picker, 0x0111, new IntPtr(1), confirm))
                return Result.PickerOpen;

            var expectedId = UnpackedId(folder);
            if (!WaitFor(() => !PickerVisible && HasInstalledExtension(browser, page, expectedId), 8000, cancellation))
                return Result.Unverified;

            CloseSetupWindow(browser, page);
            return Result.Installed;
        }
    }

    internal static ProcessStartInfo NewWindow(string exe, string page)
    {
        return new ProcessStartInfo(exe, "--new-window " + page) { UseShellExecute = false };
    }

    internal static Attempt Open(ProcessStartInfo start, string page, string folder,
        Action<bool> developerModeGuide = null, CancellationToken cancellation = default(CancellationToken),
        int developerModeWait = 90000, Action openPageGuide = null)
    {
        var result = Result.OpenFailed;
        var window = IntPtr.Zero;
        var picker = IntPtr.Zero;
        try
        {
            cancellation.ThrowIfCancellationRequested();
            var existing = BrowserWindows(start.FileName);
            using (Process.Start(start)) { }
            result = Result.WindowUnavailable;

            InvokePattern load = null;
            IntPtr editedWindow = IntPtr.Zero;
            var addressChanged = Stopwatch.StartNew();
            int navigations = 0;
            var pageReady = WaitFor(() =>
            {
                var candidates = BrowserWindows(start.FileName);
                candidates.ExceptWith(existing);
                if (candidates.Count != 1) return false;
                foreach (var candidate in candidates) window = candidate;
                result = Result.PageUnavailable;
                var root = AutomationElement.FromHandle(window);
                var address = root.FindFirst(TreeScope.Descendants, new PropertyCondition(
                    AutomationElement.ClassNameProperty, "OmniboxViewViews"));
                var current = ReadValue(address);
                if (current == null) return false;
                if (IsPage(current, page))
                {
                    bool pageLoaded;
                    load = FindLoadButton(root, page, out pageLoaded);
                    if (pageLoaded)
                    {
                        result = Result.Manual;
                        return load != null || developerModeGuide != null;
                    }
                    // The text can be ready before Chromium's address editor accepts Enter.
                    if (editedWindow == window && navigations < 3 &&
                        addressChanged.ElapsedMilliseconds >= (navigations == 0 ? 150 : 900) &&
                        Activate(window))
                    {
                        if (HasFocus(window, address))
                        {
                            SendKeys.SendWait("{ENTER}");
                            navigations++;
                            addressChanged.Restart();
                        }
                    }
                    return false;
                }
                // Some launches open a new tab instead of honoring the internal URL.
                if (navigations < 3 && IsBlankPage(current) && Activate(window))
                {
                    address.SetFocus();
                    var value = (ValuePattern)address.GetCurrentPattern(ValuePattern.Pattern);
                    value.SetValue(page);
                    if (IsPage(value.Current.Value, page))
                    {
                        editedWindow = window;
                        addressChanged.Restart();
                    }
                }
                return false;
            }, 12000, cancellation);

            if (!pageReady)
            {
                if (result != Result.PageUnavailable || openPageGuide == null || !IsWindowVisible(window))
                    return new Attempt(result, window, picker);

                openPageGuide();
                var opened = WaitFor(() => !IsWindowVisible(window) || FindExtensionsDocument(window, page) != null,
                    developerModeWait, cancellation, 250);
                if (!opened || !IsWindowVisible(window))
                    return new Attempt(result, window, picker);
                result = Result.Manual;
                load = FindLoadButton(window, page);
            }

            if (load == null)
            {
                // Allow the page a moment to finish exposing its controls before prompting.
                WaitFor(() => (load = FindLoadButton(window, page)) != null, 650, cancellation);
                if (load == null && developerModeGuide != null && IsWindowVisible(window))
                {
                    FocusDeveloperMode(window, page);
                    developerModeGuide(true);
                    WaitFor(() => !IsWindowVisible(window) ||
                        (load = FindLoadButton(window, page)) != null, developerModeWait, cancellation, 250);
                    if (load == null && IsWindowVisible(window)) result = Result.DeveloperModeTimedOut;
                }
                if (load == null) return new Attempt(result, window, picker);
            }

            var existingDialogs = Dialogs(window);
            cancellation.ThrowIfCancellationRequested();
            if (developerModeGuide != null) developerModeGuide(false);
            load.Invoke();
            if (!WaitFor(() =>
            {
                foreach (var dialog in Dialogs(window))
                {
                    if (existingDialogs.Contains(dialog)) continue;
                    picker = dialog;
                    return true;
                }
                return false;
            }, 3500, cancellation)) return new Attempt(result, window, picker);

            result = Result.PickerOpen;
            bool positioned = false;
            WaitFor(() =>
            {
                if (!IsWindowVisible(picker)) return true;
                try { return positioned = NavigatePicker(picker, folder); }
                catch (InvalidOperationException) { return false; }
            }, 5000, cancellation);
            if (positioned) result = Result.FolderReady;
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception error)
        {
            // Browser startup, UI Automation providers and foreground access can all fail.
            Debug.WriteLine(error);
        }
        return new Attempt(result, window, picker);
    }

    private static bool IsPage(string current, string page)
    {
        return current != null && string.Equals(current.TrimEnd('/'), page.TrimEnd('/'),
            StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsBlankPage(string address)
    {
        return address.Length == 0 || IsPage(address, "about:blank") ||
            IsPage(address, "edge://newtab/") || IsPage(address, "chrome://newtab/");
    }

    private static InvokePattern FindLoadButton(AutomationElement root, string page, out bool pageLoaded)
    {
        pageLoaded = false;
        var documents = root.FindAll(TreeScope.Descendants, new PropertyCondition(
            AutomationElement.ControlTypeProperty, ControlType.Document));
        foreach (AutomationElement document in documents)
        {
            if (document.Current.IsOffscreen || !IsPage(ReadValue(document), page)) continue;
            pageLoaded = true;
            var load = document.FindFirst(TreeScope.Descendants, new AndCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
                new PropertyCondition(AutomationElement.IsEnabledProperty, true),
                new PropertyCondition(AutomationElement.IsOffscreenProperty, false),
                new OrCondition(
                    new PropertyCondition(AutomationElement.AutomationIdProperty, "loadUnpacked"),
                    new PropertyCondition(AutomationElement.NameProperty, "Load unpacked", PropertyConditionFlags.IgnoreCase),
                    new PropertyCondition(AutomationElement.NameProperty, "加载已解压的扩展程序"),
                    new PropertyCondition(AutomationElement.NameProperty, "加载解压缩的扩展"),
                    new PropertyCondition(AutomationElement.NameProperty, "加载解压缩的扩展程序"),
                    new PropertyCondition(AutomationElement.NameProperty, "載入未封裝項目"),
                    new PropertyCondition(AutomationElement.NameProperty, "載入解壓縮"))));
            object pattern;
            if (load != null && load.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
                return (InvokePattern)pattern;
        }
        return null;
    }

    private static InvokePattern FindLoadButton(IntPtr window, string page)
    {
        if (!IsWindowVisible(window)) return null;
        bool pageLoaded;
        return FindLoadButton(AutomationElement.FromHandle(window), page, out pageLoaded);
    }

    private static void FocusDeveloperMode(IntPtr window, string page)
    {
        try
        {
            var document = FindExtensionsDocument(window, page);
            if (document == null) return;
            var toggle = document.FindFirst(TreeScope.Descendants, new AndCondition(
                new PropertyCondition(AutomationElement.IsKeyboardFocusableProperty, true),
                new PropertyCondition(AutomationElement.IsOffscreenProperty, false),
                new OrCondition(
                    new PropertyCondition(AutomationElement.AutomationIdProperty, "devMode"),
                    new PropertyCondition(AutomationElement.AutomationIdProperty, "dev-switch"))));
            if (toggle != null) toggle.SetFocus();
        }
        catch (ElementNotAvailableException) { }
        catch (InvalidOperationException) { }
    }

    internal static string UnpackedId(string folder)
    {
        var path = Path.GetFullPath(folder).TrimEnd('\\');
        if (path.Length > 1 && path[1] == ':') path = char.ToUpperInvariant(path[0]) + path.Substring(1);
        byte[] hash;
        using (var sha = SHA256.Create()) hash = sha.ComputeHash(Encoding.Unicode.GetBytes(path));
        var id = new StringBuilder(32);
        for (var i = 0; i < 16; i++)
        {
            id.Append((char)('a' + (hash[i] >> 4)));
            id.Append((char)('a' + (hash[i] & 15)));
        }
        return id.ToString();
    }

    private static AutomationElement FindExtensionsDocument(IntPtr window, string page)
    {
        if (!IsWindowVisible(window)) return null;
        var root = AutomationElement.FromHandle(window);
        var condition = new AndCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
            new PropertyCondition(ValuePattern.ValueProperty, page),
            new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
        return root.FindFirst(TreeScope.Descendants, condition);
    }

    private static bool HasInstalledExtension(IntPtr window, string page, string id)
    {
        var document = FindExtensionsDocument(window, page);
        if (document == null) return false;
        var texts = document.FindAll(TreeScope.Descendants, new PropertyCondition(
            AutomationElement.ControlTypeProperty, ControlType.Text));
        foreach (AutomationElement node in texts)
        {
            var name = node.Current.Name.Trim();
            if (name == id || name.EndsWith(": " + id, StringComparison.Ordinal) ||
                name.EndsWith("：" + id, StringComparison.Ordinal)) return true;
        }
        return false;
    }

    private static void CloseSetupWindow(IntPtr window, string page)
    {
        try
        {
            if (FindExtensionsDocument(window, page) == null) return;
            var root = AutomationElement.FromHandle(window);
            var tabs = root.FindAll(TreeScope.Descendants, new PropertyCondition(
                AutomationElement.ControlTypeProperty, ControlType.TabItem));
            // Leave the window open if another tab appeared or the tab strip cannot be read.
            if (tabs.Count == 1) PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
        }
        catch (ElementNotAvailableException) { }
        catch (InvalidOperationException) { }
    }

    internal static bool NavigatePicker(IntPtr picker, string folder)
    {
        if (!File.Exists(Path.Combine(folder, "manifest.json"))) return false;
        var address = OpenPickerAddress(picker);
        if (address == null) return false;
        var value = (ValuePattern)address.GetCurrentPattern(ValuePattern.Pattern);
        value.SetValue(folder);
        var editor = new IntPtr(address.Current.NativeWindowHandle);
        if (!SamePath(value.Current.Value, folder) || !IsPickerAddress(picker, editor)) return false;

        // Deliver Enter to the address editor, even if another window owns the foreground.
        // The folder confirmation button never receives a click or key from the installer.
        if (!PostKey(editor, 0x0D, 0x1C, false) ||
            !WaitFor(() => !IsWindowVisible(editor), 2000) || !IsWindowVisible(picker))
            return false;

        var current = OpenPickerAddress(picker);
        if (current == null) return false;
        var arrived = SamePath(ReadValue(current), folder);
        if (arrived && Activate(picker))
        {
            var confirm = GetDlgItem(picker, 1);
            if (confirm != IntPtr.Zero)
            {
                try { AutomationElement.FromHandle(confirm).SetFocus(); }
                catch (InvalidOperationException) { }
                catch (ElementNotAvailableException) { }
            }
        }
        return arrived;
    }

    private static AutomationElement OpenPickerAddress(IntPtr picker)
    {
        if (!IsWindowVisible(picker)) return null;
        var dialog = AutomationElement.FromHandle(picker);
        var condition = new AndCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit),
            new PropertyCondition(AutomationElement.AutomationIdProperty, "41477"),
            new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
        var edit = dialog.FindFirst(TreeScope.Descendants, condition);
        if (edit != null && IsPickerAddress(picker, new IntPtr(edit.Current.NativeWindowHandle))) return edit;
        if (!PostKey(picker, 0x44, 0x20, true)) return null;
        return WaitFor(() =>
        {
            edit = dialog.FindFirst(TreeScope.Descendants, condition);
            return edit != null && IsPickerAddress(picker, new IntPtr(edit.Current.NativeWindowHandle));
        }, 1200) ? edit : null;
    }

    private static bool PostKey(IntPtr handle, int key, int scanCode, bool alt)
    {
        var details = 1 | (scanCode << 16) | (alt ? 1 << 29 : 0);
        return PostMessage(handle, alt ? 0x0104u : 0x0100u, new IntPtr(key), new IntPtr(details)) &&
            PostMessage(handle, alt ? 0x0105u : 0x0101u, new IntPtr(key), new IntPtr(details | unchecked((int)0xC0000000)));
    }

    private static bool Activate(IntPtr window)
    {
        return GetForegroundWindow() == window || (SetForegroundWindow(window) &&
            WaitFor(() => GetForegroundWindow() == window, 400));
    }

    private static bool HasFocus(IntPtr window, AutomationElement control)
    {
        return GetForegroundWindow() == window && Automation.Compare(control, AutomationElement.FocusedElement);
    }

    private static bool IsPickerAddress(IntPtr picker, IntPtr control)
    {
        if (ClassName(control) != "Edit" || !IsWindowVisible(control)) return false;
        bool addressBand = false;
        for (; control != IntPtr.Zero && control != picker; control = GetParent(control))
            if (ClassName(control) == "Address Band Root") addressBand = true;
        return control == picker && addressBand;
    }

    private static string ReadValue(AutomationElement element)
    {
        object value;
        return element != null && element.TryGetCurrentPattern(ValuePattern.Pattern, out value)
            ? ((ValuePattern)value).Current.Value : null;
    }

    private static bool SamePath(string first, string second)
    {
        return first != null && string.Equals(first.TrimEnd('\\'), second.TrimEnd('\\'),
            StringComparison.OrdinalIgnoreCase);
    }

    private static bool WaitFor(Func<bool> predicate, int milliseconds,
        CancellationToken cancellation = default(CancellationToken), int pollInterval = 100)
    {
        var stopwatch = Stopwatch.StartNew();
        do
        {
            cancellation.ThrowIfCancellationRequested();
            try { if (predicate()) return true; }
            catch (ElementNotAvailableException) { }
            Thread.Sleep(pollInterval);
        } while (stopwatch.ElapsedMilliseconds < milliseconds);
        return false;
    }

    private static HashSet<IntPtr> BrowserWindows(string exe)
    {
        return Windows(handle =>
        {
            if (ClassName(handle) != "Chrome_WidgetWin_1" || GetWindow(handle, 4) != IntPtr.Zero) return false;
            uint pid;
            GetWindowThreadProcessId(handle, out pid);
            try
            {
                using (var process = Process.GetProcessById((int)pid))
                    return string.Equals(process.MainModule.FileName, exe, StringComparison.OrdinalIgnoreCase);
            }
            catch (InvalidOperationException) { return false; }
            catch (ArgumentException) { return false; }
            catch (System.ComponentModel.Win32Exception) { return false; }
        });
    }

    private static HashSet<IntPtr> Dialogs(IntPtr owner)
    {
        return Windows(handle => ClassName(handle) == "#32770" && GetAncestor(handle, 3) == owner &&
            GetDlgItem(handle, 1) != IntPtr.Zero &&
            FindWindowEx(handle, IntPtr.Zero, "DUIViewWndClassName", null) != IntPtr.Zero);
    }

    private static HashSet<IntPtr> Windows(Func<IntPtr, bool> matches)
    {
        var windows = new HashSet<IntPtr>();
        EnumWindows((handle, unused) =>
        {
            if (IsWindowVisible(handle) && matches(handle)) windows.Add(handle);
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    private static string ClassName(IntPtr handle)
    {
        var name = new StringBuilder(128);
        GetClassName(handle, name, name.Capacity);
        return name.ToString();
    }

    private delegate bool EnumWindowCallback(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder name, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string caption);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr handle, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr handle, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr handle, int controlId);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr handle, uint message, IntPtr key, IntPtr details);
}
