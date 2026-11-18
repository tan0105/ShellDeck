using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string runtimeDir = Path.Combine(root, "runtime");
            string runtimeExe = Path.Combine(runtimeDir, "ShellDeckRuntime.exe");
            if (!File.Exists(runtimeExe))
            {
                MessageBox.Show(
                    "未找到 runtime\\ShellDeckRuntime.exe。请重新解压完整的 ShellDeck 文件夹，不要只复制入口 exe。",
                    "ShellDeck",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return;
            }

            string dataDir = Path.Combine(root, "data");
            Directory.CreateDirectory(dataDir);
            Environment.SetEnvironmentVariable("SHELLDECK_DATA_DIR", dataDir);
            Environment.SetEnvironmentVariable("PORTABLE_EXECUTABLE_DIR", root);

            ProcessStartInfo start = new ProcessStartInfo(runtimeExe);
            start.WorkingDirectory = runtimeDir;
            start.UseShellExecute = false;
            if (args.Length > 0)
            {
                StringBuilder builder = new StringBuilder();
                for (int i = 0; i < args.Length; i++)
                {
                    if (i > 0) builder.Append(' ');
                    builder.Append('"').Append(args[i].Replace("\"", "\\\"")).Append('"');
                }
                start.Arguments = builder.ToString();
            }
            Process.Start(start);
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "ShellDeck 启动失败：" + error.Message,
                "ShellDeck",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }
}
