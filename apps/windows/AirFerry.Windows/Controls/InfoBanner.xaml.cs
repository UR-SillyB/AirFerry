using System.Windows;
using System.Windows.Controls;

namespace AirFerry.Windows.Controls;

/// <summary>Severity levels — member names mirror WPF-UI's InfoBarSeverity so
/// existing view code-behind compiles with only the using directive changed.</summary>
public enum InfoBarSeverity
{
    Informational,
    Success,
    Warning,
    Error,
}

/// <summary>
/// Inline severity banner replacing WPF-UI's InfoBar (HandyControl 3.5.1 has
/// no equivalent — its Growl is a transient toast, not a persistent inline
/// banner). Severity brushes resolve from the AirFerry semantic tokens
/// (SuccessBrush/ErrorBrush/WarningBrush, and the brand PrimaryBrush for
/// Informational), so the banner follows theme swaps live.
/// </summary>
public partial class InfoBanner : UserControl
{
    public static readonly DependencyProperty SeverityProperty =
        DependencyProperty.Register(
            nameof(Severity),
            typeof(InfoBarSeverity),
            typeof(InfoBanner),
            new PropertyMetadata(InfoBarSeverity.Informational, OnVisualsChanged));

    public static readonly DependencyProperty TitleProperty =
        DependencyProperty.Register(
            nameof(Title),
            typeof(string),
            typeof(InfoBanner),
            new PropertyMetadata(null, OnTextChanged));

    public static readonly DependencyProperty MessageProperty =
        DependencyProperty.Register(
            nameof(Message),
            typeof(string),
            typeof(InfoBanner),
            new PropertyMetadata(null, OnTextChanged));

    public InfoBanner()
    {
        InitializeComponent();
        ApplySeverity();
        ApplyText();
    }

    public InfoBarSeverity Severity
    {
        get => (InfoBarSeverity)GetValue(SeverityProperty);
        set => SetValue(SeverityProperty, value);
    }

    public string? Title
    {
        get => (string?)GetValue(TitleProperty);
        set => SetValue(TitleProperty, value);
    }

    public string? Message
    {
        get => (string?)GetValue(MessageProperty);
        set => SetValue(MessageProperty, value);
    }

    private static void OnVisualsChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        ((InfoBanner)d).ApplySeverity();
    }

    private static void OnTextChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        ((InfoBanner)d).ApplyText();
    }

    private void ApplySeverity()
    {
        // Segoe MDL2 Assets glyph per severity; brushes keyed to the AirFerry
        // semantic tokens (PrimaryBrush is the brand blue used for info).
        (string brushKey, string glyph) = Severity switch
        {
            InfoBarSeverity.Success => ("SuccessBrush", "\xE73E"),
            InfoBarSeverity.Warning => ("WarningBrush", "\xE7BA"),
            InfoBarSeverity.Error => ("ErrorBrush", "\xE783"),
            _ => ("PrimaryBrush", "\xE946"),
        };
        // Border.BackgroundProperty is a distinct DP from Control.BackgroundProperty
        // (Border derives from Decorator, not Control) — qualify it explicitly.
        TintLayer.SetResourceReference(Border.BackgroundProperty, brushKey);
        OutlineLayer.SetResourceReference(Border.BorderBrushProperty, brushKey);
        IconText.SetResourceReference(TextBlock.ForegroundProperty, brushKey);
        TitleText.SetResourceReference(TextBlock.ForegroundProperty, brushKey);
        IconText.Text = glyph;
        MessageText.SetResourceReference(TextBlock.ForegroundProperty, "TextFillColorSecondaryBrush");
    }

    private void ApplyText()
    {
        TitleText.Text = Title ?? "";
        MessageText.Text = Message ?? "";
        TitleText.Visibility = string.IsNullOrEmpty(Title)
            ? Visibility.Collapsed : Visibility.Visible;
        MessageText.Visibility = string.IsNullOrEmpty(Message)
            ? Visibility.Collapsed : Visibility.Visible;
    }
}
