using AirFerry.Windows.Bundle;

namespace AirFerry.Windows.Tests;

/// <summary>
/// Verifies the filename sanitizer. Mirrors Android's <c>FileNameUtil.kt</c>
/// tests, plus Windows-specific cases (reserved device names, trailing dots)
/// that the Windows version handles additionally.
/// </summary>
public class FileNameUtilTests
{
    [Fact]
    public void Sanitize_StripsOnlyIllegalChars_KeepsSpacesAndCjk()
    {
        // Spaces, full-width punctuation, and CJK (incl. extension) are kept.
        Assert.Equal("报告 2024.docx", FileNameUtil.Sanitize("报告 2024.docx"));
        Assert.Equal("𠀀𠀁.dat", FileNameUtil.Sanitize("𠀀𠀁.dat")); // CJK Ext B
    }

    [Fact]
    public void Sanitize_StripsIllegalChars()
    {
        Assert.Equal("a_b", FileNameUtil.Sanitize("a/b"));
        Assert.Equal("a_b", FileNameUtil.Sanitize("a:b"));
        Assert.Equal("a_b", FileNameUtil.Sanitize("a*b"));
        Assert.Equal("a_b", FileNameUtil.Sanitize("a\"b"));
        Assert.Equal("a_b", FileNameUtil.Sanitize("a|b"));
    }

    [Fact]
    public void Sanitize_ReducesToFinalPathComponent()
    {
        Assert.Equal("traverse", FileNameUtil.Sanitize("../../etc/traverse"));
        Assert.Equal("traverse", FileNameUtil.Sanitize("C:\\Windows\\traverse"));
    }

    [Fact]
    public void Sanitize_DropsLeadingDots()
    {
        Assert.Equal("hidden", FileNameUtil.Sanitize(".hidden"));
        Assert.Equal("hidden", FileNameUtil.Sanitize("....hidden"));
    }

    [Fact]
    public void Sanitize_BlankFallsBackToReceivedFile()
    {
        Assert.Equal("received_file", FileNameUtil.Sanitize(""));
        Assert.Equal("received_file", FileNameUtil.Sanitize("///"));
        Assert.Equal("received_file", FileNameUtil.Sanitize("..."));
    }

    [Fact]
    public void Sanitize_TruncatesTo200Chars()
    {
        string longName = new string('A', 300);
        string result = FileNameUtil.Sanitize(longName);
        Assert.Equal(200, result.Length);
    }

    [Fact]
    public void Sanitize_DoesNotSplitSurrogatePair()
    {
        // 199 'A's + a CJK Ext B char (surrogate pair) = length 201. Truncating
        // to 200 lands right between the high and low surrogate; the sanitizer
        // must back up one so the pair is dropped whole, not split.
        string name = new string('A', 199) + "𠀀";
        string result = FileNameUtil.Sanitize(name);
        Assert.Equal(199, result.Length); // back up from 200 to drop the lone high surrogate.
        Assert.All(result, c => Assert.Equal('A', c));
        Assert.False(char.IsLowSurrogate(result[^1]));
    }

    [Fact]
    public void Sanitize_NeutralizesWindowsReservedNames()
    {
        // CON, PRN, AUX, NUL get a trailing "_".
        Assert.Equal("CON_", FileNameUtil.Sanitize("CON"));
        Assert.Equal("PRN_", FileNameUtil.Sanitize("PRN"));
        Assert.Equal("AUX_", FileNameUtil.Sanitize("AUX"));
        Assert.Equal("NUL_", FileNameUtil.Sanitize("NUL"));
        // Case-insensitive.
        Assert.Equal("con_", FileNameUtil.Sanitize("con"));
        // COM1-9 / LPT1-9.
        Assert.Equal("COM1_", FileNameUtil.Sanitize("COM1"));
        Assert.Equal("LPT9_", FileNameUtil.Sanitize("LPT9"));
        // Even with an extension, Win32 treats CON.txt as the CON device.
        Assert.Equal("CON.txt_", FileNameUtil.Sanitize("CON.txt"));
        // Non-reserved names pass through.
        Assert.Equal("normal.txt", FileNameUtil.Sanitize("normal.txt"));
        // COM10+ are NOT reserved (only COM1-9).
        Assert.Equal("COM10", FileNameUtil.Sanitize("COM10"));
    }
}
