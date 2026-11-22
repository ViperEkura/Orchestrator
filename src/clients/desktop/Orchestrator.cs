using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class OrchestratorWindow : Form
{
    private readonly WebView2 view = new WebView2();
    private readonly string workspace;
    private Process backend;
    private string origin;
    private bool stopping;
    private readonly StringBuilder errors = new StringBuilder();
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
    [DllImport("shcore.dll")] private static extern int SetProcessDpiAwareness(int awareness);

    private static void Trace(string value) { try { if(Environment.GetEnvironmentVariable("ORCHESTRATOR_DEVTOOLS") == "1") File.AppendAllText(Path.Combine(Environment.GetEnvironmentVariable("ORCHESTRATOR_DATA_DIR") ?? AppDomain.CurrentDomain.BaseDirectory, "startup.trace"), DateTime.Now + " " + value + "\n"); } catch { } }
    public static void RunApp(string[] args)
    {
        Trace("Main");
        try { SetProcessDpiAwareness(2); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string cwd = null;
        for (int i = 0; i < args.Length - 1; i++) if (args[i] == "--cwd") cwd = args[i + 1];
        if (cwd == null) { cwd = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Orchestrator"); Directory.CreateDirectory(cwd); }
        Application.Run(new OrchestratorWindow(Path.GetFullPath(cwd)));
    }

    private OrchestratorWindow(string cwd)
    {
        Trace("Window constructor");
        workspace = cwd; Text = "Orchestrator"; Width = 1440; Height = 940; MinimumSize = new Size(780, 560);
        StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(25, 25, 25);
        string icon = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Orchestrator.ico");
        if (File.Exists(icon)) Icon = new Icon(icon);
        view.Dock = DockStyle.Fill; view.DefaultBackgroundColor = BackColor; Controls.Add(view);
        Shown += async delegate { Trace("Shown"); await Initialize(); };
        FormClosing += async delegate(object sender, FormClosingEventArgs e) {
            if (stopping) return; e.Cancel = true; stopping = true; Enabled = false;
            try { if (backend != null && !backend.HasExited) { backend.StandardInput.WriteLine("close"); await Task.Run(delegate { if (!backend.WaitForExit(8000)) backend.Kill(); }); } } catch { }
            view.Dispose(); if (backend != null) backend.Dispose(); Close();
        };
    }

    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); int dark = 1; try { DwmSetWindowAttribute(Handle, 20, ref dark, 4); } catch { } }
    private static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    private static string NodeExecutable(string resources)
    {
        string bundled = Path.Combine(resources, "node.exe");
        string installed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        // Some Windows installations grant profile access by executable location.
        // Only substitute the machine-installed runtime when its contents match the package.
        try {
            if (File.Exists(installed) && new FileInfo(installed).Length == new FileInfo(bundled).Length) {
                using (var sha = System.Security.Cryptography.SHA256.Create())
                using (var first = File.OpenRead(bundled))
                using (var second = File.OpenRead(installed)) {
                    if (Convert.ToBase64String(sha.ComputeHash(first)) == Convert.ToBase64String(sha.ComputeHash(second))) return installed;
                }
            }
        } catch (IOException) { } catch (UnauthorizedAccessException) { }
        return bundled;
    }

    private async Task Initialize()
    {
        try {
            Trace("Initialize");
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string resources = Path.Combine(root, "resources");
            var start = new ProcessStartInfo(NodeExecutable(resources), Quote(Path.Combine(resources, "runtime.mjs")) + " " + Quote(workspace) + " " + Quote(Path.Combine(resources, "web")));
            start.WorkingDirectory = workspace; start.UseShellExecute = false; start.CreateNoWindow = true;
            start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            start.StandardOutputEncoding = Encoding.UTF8; start.StandardErrorEncoding = Encoding.UTF8;
            backend = new Process(); backend.StartInfo = start;
            backend.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) lock(errors) { if(errors.Length < 16000) errors.AppendLine(e.Data); } };
            Trace("Starting backend"); backend.Start(); Trace("Backend started"); backend.BeginErrorReadLine();
            Task<string> ready = backend.StandardOutput.ReadLineAsync();
            if (await Task.WhenAny(ready, Task.Delay(20000)) != ready) throw new Exception("The local runtime did not start within 20 seconds.");
            string line = await ready;
            if (String.IsNullOrEmpty(line)) { lock(errors) throw new Exception(errors.Length > 0 ? errors.ToString() : "The local runtime stopped before startup."); }
            var data = new JavaScriptSerializer().Deserialize<Dictionary<string, string>>(line);
            origin = data["url"]; Trace("Backend ready");
            string profile = Path.Combine(Environment.GetEnvironmentVariable("ORCHESTRATOR_DATA_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".orchestrator"), "desktop", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(null, profile);
            Trace("WebView environment ready"); await view.EnsureCoreWebView2Async(environment); Trace("WebView ready");
            view.CoreWebView2.WindowCloseRequested += delegate { Close(); };
            view.CoreWebView2.Settings.IsStatusBarEnabled = false;
            view.CoreWebView2.Settings.AreDevToolsEnabled = Environment.GetEnvironmentVariable("ORCHESTRATOR_DEVTOOLS") == "1";
            view.CoreWebView2.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; };
            view.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; OpenExternal(e.Uri); };
            view.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) { Uri uri; if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out uri) || uri.GetLeftPart(UriPartial.Authority) != origin) { e.Cancel = true; OpenExternal(e.Uri); } };
            view.Source = new Uri(origin + "/#token=" + Uri.EscapeDataString(data["token"]));
            backend.EnableRaisingEvents = true;
            backend.Exited += delegate { if (!stopping && !IsDisposed) BeginInvoke((Action)delegate { MessageBox.Show(this, "The local runtime stopped. Restart Orchestrator to reconnect.", "Orchestrator", MessageBoxButtons.OK, MessageBoxIcon.Information); }); };
        } catch (Exception error) {
            try { File.WriteAllText(Path.Combine(Environment.GetEnvironmentVariable("ORCHESTRATOR_DATA_DIR") ?? AppDomain.CurrentDomain.BaseDirectory, "startup.log"), error.ToString()); } catch { }
            MessageBox.Show(this, error is WebView2RuntimeNotFoundException ? error.Message + "\n\nRun the included MicrosoftEdgeWebview2Setup.exe." : error.Message, "Orchestrator could not start", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }
    private static void OpenExternal(string address) { Uri uri; if (Uri.TryCreate(address, UriKind.Absolute, out uri) && (uri.Scheme == "http" || uri.Scheme == "https")) Process.Start(new ProcessStartInfo(address) { UseShellExecute = true }); }
}

internal static class Program {
  [STAThread] private static void Main(string[] args) {
    try { OrchestratorWindow.RunApp(args); }
    catch (Exception error) { Console.Error.WriteLine(error.GetType().FullName); Console.Error.WriteLine(error.Message); try { File.WriteAllText(Path.Combine(Environment.GetEnvironmentVariable("ORCHESTRATOR_DATA_DIR") ?? AppDomain.CurrentDomain.BaseDirectory, "fatal.log"), error.GetType().FullName + "\n" + error.Message); } catch { } }
  }
}
