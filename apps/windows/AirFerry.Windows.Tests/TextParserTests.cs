using System.Text;
using AirFerry.Windows.Bundle;
using Xunit;

namespace AirFerry.Windows.Tests;

/// <summary>
/// Verifies the text-message payload parser. Mirrors the byte layout the
/// browser sender emits (<c>apps/sender/src/wasm/text.ts</c>) and the Android
/// parser (<c>TextParser.kt</c>) checks against. These are cross-platform
/// protocol-layer tests (no WPF / P-Invoke), runnable on any OS via
/// <c>dotnet test</c>.
/// </summary>
public class TextParserTests
{
    /// <summary>Build a text payload exactly as the sender does: [ETTEXTv1][UTF-8].</summary>
    private static byte[] BuildText(string text)
    {
        byte[] body = Encoding.UTF8.GetBytes(text);
        byte[] buf = new byte[8 + body.Length];
        "ETTEXTv1"u8.CopyTo(buf);
        body.CopyTo(buf, 8);
        return buf;
    }

    [Fact]
    public void IsText_DetectsMagic()
    {
        Assert.True(TextParser.IsText(BuildText("hello")));
        Assert.True(TextParser.IsText(BuildText(""))); // empty body, magic only
        // A bundle magic is NOT a text magic.
        Assert.False(TextParser.IsText("ETBUNDL1"u8.ToArray()));
        // Plain bytes are not text.
        Assert.False(TextParser.IsText(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 }));
        Assert.False(TextParser.IsText([]));
    }

    [Fact]
    public void Parse_Ascii_RoundTrips()
    {
        byte[] buf = BuildText("AirFerry text transfer");
        string? text = TextParser.Parse(buf);
        Assert.Equal("AirFerry text transfer", text);
    }

    [Fact]
    public void Parse_Unicode_RoundTrips()
    {
        // Chinese + emoji + line breaks exercise multi-byte UTF-8.
        string msg = "你好，世界！🌍\n第二行\n\nAirFerry 文字传输";
        byte[] buf = BuildText(msg);
        string? text = TextParser.Parse(buf);
        Assert.Equal(msg, text);
    }

    [Fact]
    public void Parse_EmptyBody_RoundTrips()
    {
        // Magic with no body should decode to the empty string, not null.
        byte[] buf = BuildText("");
        string? text = TextParser.Parse(buf);
        Assert.Equal("", text);
    }

    [Fact]
    public void Parse_Rejects_BadMagic()
    {
        Assert.Null(TextParser.Parse("ETBUNDL1"u8.ToArray()));
        Assert.Null(TextParser.Parse(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 }));
    }
}
