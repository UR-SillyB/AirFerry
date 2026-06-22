namespace AirFerry.Windows.Scan;

/// <summary>
/// Table-driven CRC32 (IEEE 802.3, same polynomial as the sender's). Mirrors
/// Android's <c>ScanActivity.crc32OfBytes</c>: returns the unsigned 32-bit CRC
/// in a <see cref="ulong"/> so values like <c>0xDEADBEEF</c> survive (a signed
/// int would render them negative).
/// </summary>
public static class Crc32
{
    private static readonly uint[] Table = BuildTable();

    private static uint[] BuildTable()
    {
        var t = new uint[256];
        for (uint i = 0; i < 256; i++)
        {
            uint c = i;
            for (int k = 0; k < 8; k++)
            {
                c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            }
            t[i] = c;
        }
        return t;
    }

    /// <summary>Compute CRC32 over <paramref name="data"/> as an unsigned ulong.</summary>
    public static ulong Compute(ReadOnlySpan<byte> data)
    {
        uint crc = 0xFFFF_FFFFu;
        foreach (byte b in data)
        {
            crc = (crc >> 8) ^ Table[(crc ^ b) & 0xFF];
        }
        return (crc ^ 0xFFFF_FFFFu);
    }
}
