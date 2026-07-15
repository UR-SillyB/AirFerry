using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using AirFerry.Windows.ViewModels;
using CvPoint = OpenCvSharp.Point;
using CvSize = OpenCvSharp.Size;
using CvVideoCapture = OpenCvSharp.VideoCapture;
using Mat = OpenCvSharp.Mat;

namespace AirFerry.Windows.Views;

/// <summary>
/// Scan page code-behind — owns the <see cref="ScanViewModel"/> and renders its
/// state into the WPF surface. The preview is a <see cref="WriteableBitmap"/>
/// refreshed off the producer thread (camera → BGR → WriteableBitmap → Image).
/// A <see cref="DispatcherTimer"/> polls the VM for progress at ~7 Hz (mirrors
/// Android's UI refresh cadence).
/// </summary>
public partial class ScanView : Page
{
    private readonly ScanViewModel _vm;
    private readonly DispatcherTimer _progressTimer;
    private readonly DispatcherTimer _previewTimer;
    private AirFerry.Windows.Scan.VideoCapture? _previewCapture;

    public ScanView(int deviceIndex)
    {
        InitializeComponent();
        _vm = new ScanViewModel();
        _vm.TransferCompleted += OnTransferCompleted;

        // Progress poll at 7 Hz (same as Android's ~7Hz UI refresh). Also syncs
        // the VM's observable fields into the WPF text controls each tick.
        _progressTimer = new DispatcherTimer(TimeSpan.FromMilliseconds(140),
            DispatcherPriority.Normal, (_, _) =>
            {
                _vm.RefreshProgress();
                StatusText.Text = _vm.StatusText;
                ProgressText.Text = $"{_vm.ReceivedSymbolsText} / {_vm.TotalSymbolsText}";
                DrawProgressRing(_vm.Progress);
                if (!string.IsNullOrEmpty(_vm.RecoveryStageText))
                {
                    RecoveryStageText.Text = _vm.RecoveryStageText;
                    RecoveryStageText.Visibility = Visibility.Visible;
                }
                else
                {
                    RecoveryStageText.Visibility = Visibility.Collapsed;
                }
            }, Dispatcher)
        {
            IsEnabled = false,
        };

        // Preview refresh at ~15 Hz (lighter than decode path to keep UI responsive).
        _previewTimer = new DispatcherTimer(TimeSpan.FromMilliseconds(66),
            DispatcherPriority.Render, (_, _) => RenderPreview(), Dispatcher)
        {
            IsEnabled = false,
        };

        Loaded += (_, _) => Start(deviceIndex);
        Unloaded += (_, _) => Cleanup();
    }

    private void Start(int deviceIndex)
    {
        DrawProgressRing(0);
        _vm.StartScan(deviceIndex);
        _progressTimer.Start();
        // Open a SEPARATE capture for preview only — the VM's capture feeds the
        // decode pool; this one feeds the UI. Two handles to the same device work
        // under DirectShow (one read, one read) as long as the driver allows it.
        // If the driver is exclusive, the preview simply won't update and the
        // scan still works — the preview is cosmetic.
        try
        {
            _previewCapture = new AirFerry.Windows.Scan.VideoCapture(deviceIndex, 960, 540, 30);
        }
        catch
        {
            _previewCapture = null;
        }
        _previewTimer.Start();
    }

    private void RenderPreview()
    {
        if (_previewCapture is null || !_previewCapture.IsOpen)
        {
            return;
        }
        Mat? bgr = _previewCapture.ReadBgr();
        if (bgr is null || bgr.Empty())
        {
            return;
        }
        // Convert BGR Mat → WriteableBitmap. Recreate the bitmap only when the
        // frame size changes (typical: stable across frames).
        if (PreviewImage.Source is not WriteableBitmap wb ||
            wb.PixelWidth != bgr.Width || wb.PixelHeight != bgr.Height)
        {
            wb = new WriteableBitmap(bgr.Width, bgr.Height, 96, 96, PixelFormats.Bgr24, null);
            PreviewImage.Source = wb;
        }
        // Write the Mat's bytes into the bitmap. WriteableBitmap expects Bgr24
        // (3 bytes/pixel) which matches OpenCV's BGR Mat.
        int stride = bgr.Width * 3;
        wb.Lock();
        try
        {
            unsafe
            {
                Buffer.MemoryCopy((void*)bgr.Data, (void*)wb.BackBuffer,
                    stride * bgr.Height, stride * bgr.Height);
            }
            wb.AddDirtyRect(new Int32Rect(0, 0, bgr.Width, bgr.Height));
        }
        finally
        {
            wb.Unlock();
        }
    }

    /// <summary>Draw the circular progress ring (0..100) on the overlay canvas.</summary>
    private void DrawProgressRing(double percent)
    {
        ProgressCanvas.Children.Clear();
        double size = 180;
        double stroke = 12;
        double radius = (size - stroke) / 2;
        Point center = new(size / 2, size / 2);

        // Background ring.
        var bg = new System.Windows.Shapes.Ellipse
        {
            Width = size, Height = size,
            Stroke = new SolidColorBrush(Color.FromRgb(0x33, 0x41, 0x55)),
            StrokeThickness = stroke,
        };
        Canvas.SetLeft(bg, 0);
        Canvas.SetTop(bg, 0);
        ProgressCanvas.Children.Add(bg);

        // Progress arc (drawn as a Path because WPF has no arc shape).
        double angle = Math.Clamp(percent, 0, 100) / 100.0 * 360.0;
        if (angle > 0)
        {
            double rad = (angle - 90) * Math.PI / 180.0;
            Point end = new(
                center.X + radius * Math.Cos(rad),
                center.Y + radius * Math.Sin(rad));
            bool largeArc = angle > 180;
            var arc = new System.Windows.Shapes.Path
            {
                Stroke = (Brush)FindResource("Accent"),
                StrokeThickness = stroke,
                Data = new PathGeometry
                {
                    Figures =
                    {
                        new PathFigure
                        {
                            StartPoint = new(center.X, center.Y - radius),
                            Segments = { new ArcSegment(end, new Size(radius, radius), 0, largeArc, SweepDirection.Clockwise, true) },
                        },
                    },
                },
            };
            ProgressCanvas.Children.Add(arc);
        }

        // Percent label.
        var label = new TextBlock
        {
            Text = $"{percent:F0}%",
            FontSize = 28,
            FontWeight = FontWeights.Bold,
            Foreground = (Brush)FindResource("TextPrimary"),
        };
        Canvas.SetLeft(label, center.X - 30);
        Canvas.SetTop(label, center.Y - 20);
        ProgressCanvas.Children.Add(label);
    }

    private void OnTransferCompleted(Models.RecoveryResult result)
    {
        Dispatcher.BeginInvoke(() =>
        {
            DrawProgressRing(100);
            if (result.IsText)
            {
                // Prefer original filename for text-like docs (readme.md…);
                // ETTEXTv1 has no path — ReceiveTextView defaults to 文字消息.txt.
                string? suggested = result.SingleFilePath is not null
                    ? System.IO.Path.GetFileName(result.SingleFilePath)
                    : null;
                NavigationService?.Navigate(new ReceiveTextView(result, suggested));
            }
            else if (result.IsBundle && result.Bundle is not null)
            {
                NavigationService?.Navigate(new ReceiveBundleView(result));
            }
            else if (result.SingleFilePath is not null)
            {
                NavigationService?.Navigate(new ReceiveDetailView(result));
            }
        });
    }

    // Bind VM properties → UI on each progress tick (simpler than full INotifyPropertyChanged hookup).
    // Called via the VM's RefreshProgress indirectly: we poll VM fields here.

    private void Back_Click(object sender, RoutedEventArgs e) => CleanupAndGoBack();

    private void Stop_Click(object sender, RoutedEventArgs e) => _vm.StopScan();

    private void FileList_Click(object sender, RoutedEventArgs e)
    {
        NavigationService?.Navigate(new FileListView());
    }

    private void Cleanup()
    {
        _progressTimer.Stop();
        _previewTimer.Stop();
        _previewCapture?.Dispose();
        _previewCapture = null;
    }

    private void CleanupAndGoBack()
    {
        Cleanup();
        _vm.Dispose();
        NavigationService?.GoBack();
    }
}
