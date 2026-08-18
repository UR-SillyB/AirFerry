using System.IO;
using System.Text;

namespace AirFerry.Windows.Bundle;

/// <summary>
/// Materializes user-facing share copies with their logical filenames.
/// ContentStore blobs are deliberately named by SHA-256 and have no extension;
/// exposing those paths in Explorer loses the filename and makes recipients
/// treat the data as a generic binary file.
/// </summary>
public static class ShareExport
{
    private static readonly TimeSpan DefaultRetention = TimeSpan.FromHours(24);
    private const string ZoneIdentifier = "[ZoneTransfer]\r\nZoneId=3\r\n";

    public static string ExportFile(
        string sourcePath,
        string displayName,
        string? rootDirectory = null)
    {
        if (!File.Exists(sourcePath))
        {
            throw new FileNotFoundException("Share source does not exist", sourcePath);
        }
        PruneExpired(rootDirectory);
        string dir = CreateShareDirectory(rootDirectory);
        try
        {
            string target = FileNameUtil.UniqueTarget(dir, displayName);
            File.Copy(sourcePath, target, overwrite: false);
            MarkAsUntrusted(target);
            return target;
        }
        catch
        {
            TryDeleteDirectory(dir);
            throw;
        }
    }

    /// <summary>Streaming overload for path-backed recovered bundle members.</summary>
    public static string ExportFiles(
        IEnumerable<BundleFile> files,
        string? rootDirectory = null)
    {
        PruneExpired(rootDirectory);
        string dir = CreateShareDirectory(rootDirectory);
        try
        {
            foreach (BundleFile file in files)
            {
                string target = FileNameUtil.UniqueRelativeTarget(dir, file.Name);
                file.CopyTo(target);
                MarkAsUntrusted(target);
            }
            return dir;
        }
        catch
        {
            TryDeleteDirectory(dir);
            throw;
        }
    }

    public static string ExportFiles(
        IEnumerable<(string Name, byte[] Data)> files,
        string? rootDirectory = null)
    {
        PruneExpired(rootDirectory);
        string dir = CreateShareDirectory(rootDirectory);
        try
        {
            foreach ((string name, byte[] data) in files)
            {
                string target = FileNameUtil.UniqueTarget(dir, name);
                File.WriteAllBytes(target, data);
                MarkAsUntrusted(target);
            }
            return dir;
        }
        catch
        {
            TryDeleteDirectory(dir);
            throw;
        }
    }

    /// <summary>
    /// Remove stale share directories created by this class. Called at app
    /// startup and before each export; failures are deliberately non-fatal.
    /// </summary>
    public static int PruneExpired(
        string? rootDirectory = null,
        TimeSpan? retention = null,
        DateTime? utcNow = null)
    {
        string root = ResolveRoot(rootDirectory);
        if (!Directory.Exists(root))
        {
            return 0;
        }
        DateTime cutoff = (utcNow ?? DateTime.UtcNow) - (retention ?? DefaultRetention);
        int removed = 0;
        foreach (string dir in Directory.EnumerateDirectories(root))
        {
            try
            {
                string name = Path.GetFileName(dir);
                if (!IsExportDirectoryName(name) ||
                    (File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0 ||
                    Directory.GetLastWriteTimeUtc(dir) > cutoff)
                {
                    continue;
                }
                Directory.Delete(dir, recursive: true);
                removed++;
            }
            catch
            {
                // A share target may still have the file open. Retry on a later
                // startup/share instead of breaking the user's current action.
            }
        }
        return removed;
    }

    private static string CreateShareDirectory(string? rootDirectory)
    {
        string root = ResolveRoot(rootDirectory);
        string dir = Path.Combine(root, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string ResolveRoot(string? rootDirectory) =>
        rootDirectory ?? Path.Combine(Path.GetTempPath(), "AirFerry", "share");

    private static bool IsExportDirectoryName(string name) =>
        name.Length == 32 && name.All(Uri.IsHexDigit);

    private static void MarkAsUntrusted(string path)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }
        // Optical input is untrusted just like a downloaded attachment. The
        // Zone.Identifier ADS makes Explorer/SmartScreen warn before execution.
        File.WriteAllText(
            path + ":Zone.Identifier",
            ZoneIdentifier,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
    }

    private static void TryDeleteDirectory(string dir)
    {
        try
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
            // Best effort after an already-failing export.
        }
    }
}
