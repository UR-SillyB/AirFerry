using System.Text.Json;
using Xunit;
using Xunit.Abstractions;

namespace AirFerry.Windows.Tests;

/// <summary>
/// AF2 cross-platform golden-vector assertions (C# side).
/// Reads <c>core/testdata/af2/manifest.json</c> and verifies AF2 frame header
/// fields against the golden specification. The header probe below is
/// TEST-ONLY: production code must not mirror the wire format (SPEC §9) —
/// the Rust core is the single wire authority.
/// </summary>
public sealed class Af2GoldenVectorTests
{
    private const ushort MagicAf = 0x4146; // ASCII "AF"
    private const byte WireVersion2 = 2;

    private readonly ITestOutputHelper _output;
    public Af2GoldenVectorTests(ITestOutputHelper output) => _output = output;

    private static string FindAf2FixtureDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "core", "testdata", "af2");
            if (File.Exists(Path.Combine(candidate, "manifest.json")))
            {
                return candidate;
            }
            dir = dir.Parent;
        }
        throw new FileNotFoundException(
            "core/testdata/af2/manifest.json not found above the test output directory");
    }

    private static byte[] Unhex(string hex)
    {
        return Convert.FromHexString(hex);
    }

    private readonly record struct WireHeader(
        ushort Magic, byte Version, byte FrameType, byte Sbn, uint Esi);

    private static WireHeader? ParseWireHeader(byte[] b)
    {
        if (b.Length < 26)
        {
            return null;
        }
        return new WireHeader(
            (ushort)((b[0] << 8) | b[1]),
            b[2],
            b[3],
            b[22],
            ((uint)b[23] << 16) | ((uint)b[24] << 8) | b[25]);
    }

    [Fact]
    public void Af2GoldenVectors_VerifyHeaders()
    {
        var dir = FindAf2FixtureDir();
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "manifest.json")));
        var root = doc.RootElement;

        // 1. Verify ROOT frame header
        var rootFrameBytes = Unhex(root.GetProperty("root_frame_hex").GetString()!);
        var rootHeader = ParseWireHeader(rootFrameBytes);
        Assert.NotNull(rootHeader);
        Assert.Equal(MagicAf, rootHeader!.Value.Magic);
        Assert.Equal(WireVersion2, rootHeader.Value.Version);
        Assert.Equal(1u, rootHeader.Value.FrameType); // ROOT

        // 2. Verify OBJECT_META frame header
        var metaFrameBytes = Unhex(root.GetProperty("object_meta_frame_hex").GetString()!);
        var metaHeader = ParseWireHeader(metaFrameBytes);
        Assert.NotNull(metaHeader);
        Assert.Equal(2u, metaHeader!.Value.FrameType); // OBJECT_META

        // 3. Verify SYMBOL frame header
        var symbolFrameBytes = Unhex(root.GetProperty("symbol_frame_hex").GetString()!);
        var symbolHeader = ParseWireHeader(symbolFrameBytes);
        Assert.NotNull(symbolHeader);
        Assert.Equal(3u, symbolHeader!.Value.FrameType); // SYMBOL
        Assert.Equal(1u, symbolHeader.Value.Sbn);
        Assert.Equal(42u, symbolHeader.Value.Esi);

        _output.WriteLine("AF2 C# golden headers verified successfully");
    }
}
