using System;
using System.IO;
using System.IO.Compression;

internal static class ExtensionFiles
{
    internal static string Install(string root, ZipArchive package)
    {
        Directory.CreateDirectory(root);
        var destination = Path.Combine(root, "extension");
        var backup = Path.Combine(root, "extension.previous");
        using (File.Open(Path.Combine(root, "setup.lock"), FileMode.OpenOrCreate, FileAccess.Write, FileShare.None))
        {
            if (Directory.Exists(backup))
            {
                if (Directory.Exists(destination)) Directory.Delete(backup, true);
                else Directory.Move(backup, destination);
            }

            var stage = Path.Combine(root, "setup-" + Guid.NewGuid().ToString("N"));
            try
            {
                package.ExtractToDirectory(stage);
                var staged = Path.Combine(stage, "extension");
                foreach (var required in new[] { "manifest.json", "manager.js" })
                    if (!File.Exists(Path.Combine(staged, required)))
                        throw new IOException("安装包缺少 " + required + "。");

                Publish(staged, destination, backup);
                return destination;
            }
            finally
            {
                TryRemove(stage);
            }
        }
    }

    internal static void Publish(string staged, string destination, string backup)
    {
        // Keep the original path and replace the entire folder after extraction succeeds.
        var hadPrevious = Directory.Exists(destination);
        if (hadPrevious) Directory.Move(destination, backup);
        try
        {
            Directory.Move(staged, destination);
        }
        catch
        {
            if (hadPrevious)
            {
                try { Directory.Move(backup, destination); }
                catch (Exception recovery)
                {
                    throw new IOException("未能恢复原扩展目录。旧版已保留在 " + backup + "，可重新运行安装器恢复。", recovery);
                }
            }
            throw;
        }
        TryRemove(backup);
    }

    private static void TryRemove(string folder)
    {
        try { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
