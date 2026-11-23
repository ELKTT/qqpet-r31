using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace QQPet.LocalLogin
{
    // A per-pixel-alpha skin underneath the ordinary editable controls. A region
    // alone has only a hard edge and loses the PNG's partially transparent pixels.
    internal sealed class LayeredLoginSkin : Form
    {
        private readonly Bitmap image;
        internal static readonly Color ClearKey = Color.FromArgb(255, 0, 255);
        internal LayeredLoginSkin(Bitmap source)
        {
            FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual; ClientSize = source.Size;
            image = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppPArgb);
            using (var graphics = Graphics.FromImage(image)) { graphics.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy; graphics.DrawImageUnscaled(source, 0, 0); }
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams { get { var value = base.CreateParams; value.ExStyle |= 0x80000 | 0x80 | 0x20 | 0x08000000; return value; } }
        internal static Bitmap OpaqueInterior(Bitmap source)
        {
            var result = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
            for (int y = 0; y < source.Height; y++) for (int x = 0; x < source.Width; x++) { Color c = source.GetPixel(x, y); result.SetPixel(x, y, c.A == 255 ? c : Color.Transparent); }
            return result;
        }
        internal void Place(Form controls)
        {
            if (!controls.Visible) { Hide(); return; }
            Rectangle bounds = controls.Bounds;
            Bounds = bounds; if (!Visible) Show();
            IntPtr screen = GetDC(IntPtr.Zero), dc = IntPtr.Zero, bitmap = IntPtr.Zero, previous = IntPtr.Zero;
            try {
                dc = CreateCompatibleDC(screen); bitmap = image.GetHbitmap(Color.FromArgb(0)); previous = SelectObject(dc, bitmap);
                var destination = new Point(bounds.X, bounds.Y); var origin = Point.Empty; var size = image.Size;
                var blend = new Blend { Operation = 0, Flags = 0, Alpha = 255, Format = 1 };
                if (!UpdateLayeredWindow(Handle, screen, ref destination, ref size, dc, ref origin, 0, ref blend, 2)) throw new Win32Exception();
                // Showing a no-activate layered window can put it above an already
                // visible owner/owned pair. Assigning Form.Owner does not repair
                // that initial native Z order. Keep this background immediately
                // behind its editable window without stealing keyboard focus.
                const uint NoSize = 0x0001, NoMove = 0x0002, NoActivate = 0x0010, NoOwnerZOrder = 0x0200;
                if (!SetWindowPos(Handle, controls.Handle, 0, 0, 0, 0, NoSize | NoMove | NoActivate | NoOwnerZOrder)) throw new Win32Exception();
            } finally { if (previous != IntPtr.Zero) SelectObject(dc, previous); if (bitmap != IntPtr.Zero) DeleteObject(bitmap); if (dc != IntPtr.Zero) DeleteDC(dc); if (screen != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screen); }
        }
        protected override void Dispose(bool disposing) { if (disposing) image.Dispose(); base.Dispose(disposing); }
        [StructLayout(LayoutKind.Sequential, Pack = 1)] private struct Blend { internal byte Operation, Flags, Alpha, Format; }
        [DllImport("user32.dll", SetLastError = true)] private static extern bool UpdateLayeredWindow(IntPtr window, IntPtr screen, ref Point position, ref Size size, IntPtr source, ref Point origin, int color, ref Blend blend, int flags);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
        [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
        [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
        [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
    }
}
