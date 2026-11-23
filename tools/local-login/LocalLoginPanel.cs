using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace QQPet.LocalLogin
{
    /// <summary>
    /// The adoption movie's command vocabulary, in one place. The movie's two SimpleButtons call
    /// its ActionScript handlers sprite412_1/CallBackB and sprite412_1/CallBackG, and those
    /// handlers push the FSCommand strings "Boy" and "Girl": what the host receives is the pushed
    /// value, not the function name. Only these two commands name a gender; everything else —
    /// the function names included — is not an adoption.
    /// </summary>
    internal static class AdoptionCommand
    {
        internal static string Gender(string command)
        {
            if (command == "Boy") return "male";
            if (command == "Girl") return "female";
            return null;
        }
    }

    /// <summary>
    /// The original adoption window: the user-specified Adopt.swf at its own 800x600 stage,
    /// hosted by the runtime copy's own Flash renderer through the launcher's side-by-side
    /// manifest. The movie's two buttons send the FSCommand strings "Boy" and "Girl" (the values
    /// the movie pushes; CallBackB and CallBackG are the ActionScript function names behind them,
    /// not the commands), and each choice is bound to the adoption handle the petless login
    /// issued: no account name, no password, and a fixed first name the server applies. Closing
    /// the window without a completed adoption keeps the account petless, exactly as the
    /// original flow does.
    /// </summary>
    internal sealed class AdoptionForm : Form
    {
        private static readonly string[] Genders = new[] { "male", "female" };
        private readonly Service service;
        private readonly string adoptToken;
        private readonly Label hint = new Label
        {
            Dock = DockStyle.Top, Height = 36, Visible = false,
            ForeColor = Color.FromArgb(0x8e, 0x58, 0x0a), BackColor = Color.White,
            TextAlign = ContentAlignment.MiddleCenter
        };
        private FlashHost flash;
        private bool busy;
        internal bool Adopted { get; private set; }
        internal byte[] Packet { get; private set; }
        internal string Failure { get; private set; }

        internal AdoptionForm(Service service, string adoptToken, string moviePath)
        {
            this.service = service; this.adoptToken = adoptToken;
            Text = "QQ宠物领养";
            FormBorderStyle = FormBorderStyle.FixedSingle;
            ClientSize = new Size(800, 600);
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = false;
            Controls.Add(hint);
            flash = new FlashHost { Dock = DockStyle.Fill };
            Controls.Add(flash);
            flash.FsCommand += command =>
            {
                // The movie's boy button sends "Boy" and its girl button "Girl": the pushed value
                // is the whole command vocabulary, and AdoptionCommand is the only place that
                // turns it into a gender. Anything else is not an adoption and never submits.
                string gender = AdoptionCommand.Gender(command);
                if (gender == null || busy || Adopted) return;
                busy = true;
                Task.Run(() =>
                {
                    byte[] packet;
                    if (service.Adopt(adoptToken, gender, out packet))
                    {
                        Adopted = true; Packet = packet;
                        try { BeginInvoke(new Action(Close)); } catch (InvalidOperationException) { }
                    }
                    else
                    {
                        busy = false;
                        try { BeginInvoke(new Action(() => { hint.Text = "领养没有完成，请重试或关闭窗口。"; hint.Visible = true; })); } catch (InvalidOperationException) { }
                    }
                });
            };
            Shown += delegate
            {
                try { flash.Load(moviePath); }
                catch (IOException missing)
                {
                    Failure = missing.Message;
                    hint.Text = "领养窗口资源缺失（" + missing.Message + "），请关闭并检查启动配置。";
                    hint.Visible = true;
                }
            };
        }
        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            if (flash != null) { flash.Dispose(); flash = null; }
            base.OnFormClosed(e);
        }
    }

    /// <summary>
    /// The client's own PetLogin UI images, read from the running copy's resource tree. A missing
    /// or unreadable file is a startup failure, not a silently blank control.
    ///
    /// Every image is decoded into a standalone 32bpp ARGB bitmap rather than returned straight
    /// from the file stream: `Image.FromStream` keeps a reference to the stream it was handed, so
    /// an image read out of a disposed stream can still paint but can no longer be re-read, which
    /// is exactly what the window silhouette needs. The copy is also what makes the alpha channel
    /// of `loginbg.png` usable for the window region: both the shape and the pixels the user sees
    /// come from the same buffer.
    /// </summary>
    internal sealed class UIResources
    {
        private readonly string root, pluginRoot;
        private readonly Dictionary<string, Bitmap> cache = new Dictionary<string, Bitmap>(StringComparer.Ordinal);
        internal UIResources(string clientExecutable)
        {
            pluginRoot = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(clientExecutable)),
                "res", "Plugins", "PetLogin");
            root = Path.Combine(pluginRoot, "UI");
        }
        internal Bitmap Image(string name)
        {
            Bitmap cached;
            if (cache.TryGetValue(name, out cached)) return cached;
            string file = Path.Combine(root, name);
            if (!File.Exists(file)) throw new IOException("UI_RESOURCE_MISSING");
            using (var stream = new MemoryStream(File.ReadAllBytes(file)))
            using (var loaded = System.Drawing.Image.FromStream(stream))
            {
                // `new Bitmap(image)` is a pixel-for-pixel copy in the source's own format, which
                // for this art is 32bpp ARGB. The graphics path is only for a source that is not
                // already in that format, where there is no alpha to move and a resampled copy
                // would be indistinguishable anyway.
                var image = loaded.PixelFormat == PixelFormat.Format32bppArgb
                    ? new Bitmap(loaded)
                    : Normalise(loaded);
                cache[name] = image;
                return image;
            }
        }
        private static Bitmap Normalise(Image loaded)
        {
            var image = new Bitmap(loaded.Width, loaded.Height, PixelFormat.Format32bppArgb);
            using (var canvas = Graphics.FromImage(image))
            {
                canvas.CompositingMode = CompositingMode.SourceCopy;
                // BMP skins carry their original 72-DPI metadata. GDI+'s
                // DrawImageUnscaled still applies physical DPI conversion;
                // copy an explicit pixel rectangle so none of the 17px art
                // is enlarged or clipped while normalising it to ARGB.
                canvas.DrawImage(loaded, new Rectangle(0, 0, loaded.Width, loaded.Height),
                    0, 0, loaded.Width, loaded.Height, GraphicsUnit.Pixel);
            }
            return image;
        }
        /// <summary>
        /// The PetLogin plugin's own icon, one directory above the UI folder. It is used for the
        /// tray control the panel leaves behind when it hides, so the running session is still
        /// recognisable; when the file is missing the caller falls back to a stock icon rather
        /// than failing a build that is otherwise complete.
        /// </summary>
        internal Icon Icon(string name)
        {
            string file = Path.Combine(pluginRoot, name);
            if (!File.Exists(file)) return null;
            using (var stream = new MemoryStream(File.ReadAllBytes(file))) return new Icon(stream);
        }
    }

    /// <summary>
    /// The original panel's geometry in one place: the form draws from these numbers and the
    /// acceptance check compares them with res/Plugins/PetLogin/UI/LoginDlg.xml, so the panel
    /// cannot drift away from the layout file it was rebuilt from.
    ///
    /// The two edit fields need one extra fact the layout file states only through its `skin`
    /// attribute. `skin="image:editbg.png;serial:2"` selects the client's own two-state skin
    /// series `editbg_00.png` (normal) and `editbg_01.png` (focused) - the same `;serial:N` that
    /// the three-state buttons follow, so the plain `editbg.png` sitting next to them is not
    /// either state. Both skins are 158x19 and their fully opaque field is 156x17, one pixel in
    /// from each edge; the visible frame is the soft 1px outline those pixels sit inside. The
    /// framework draws that sprite around the element's rectangle, so the sprite is centred on
    /// it and the editable rectangle - the height the file gives its `safeedit` element, which
    /// the 19px combobox is that field plus a 2px frame above and below - is centred on it too.
    /// Laying an editor out at the element rectangle instead is what let a control's own
    /// background and border reach past the skin.
    /// </summary>
    internal static class LoginPanelLayout
    {
        internal const int Width = 340, Height = 242, DragHeight = 53;
        internal const string Background = "loginbg.png";
        // The edit skin series, and the field inside it. EditorWidth and EditorHeight are the
        // size both skinned fields declare, the height being the one the layout file gives its
        // plain `safeedit` element - the 19px combobox is that field plus a 2px frame top and
        // bottom.
        internal const string FieldSkin = "editbg";
        internal const int SkinStates = 2, SkinWidth = 158, SkinHeight = 19,
            EditorWidth = 150, EditorHeight = 15;
        internal sealed class Field
        {
            // X/Y/W/H are the layout file's own element rectangle. The sprite that frames it and
            // the editable rectangle inside that sprite are both centred on it.
            internal readonly string Name, Image; internal readonly int X, Y, W, H;
            internal Field(string name, string image, int x, int y, int w, int h)
            { Name = name; Image = image; X = x; Y = y; W = w; H = h; }
            internal bool Skinned { get { return Image != null && Image.StartsWith(FieldSkin, StringComparison.Ordinal); } }
            internal int SkinX { get { return X - (SkinWidth - W) / 2; } }
            internal int SkinY { get { return Y - (SkinHeight - H) / 2; } }
            internal int EditorX { get { return X + (W - EditorWidth) / 2; } }
            internal int EditorY { get { return Y + (H - EditorHeight) / 2; } }
            internal Rectangle SkinBounds { get { return new Rectangle(SkinX, SkinY, SkinWidth, SkinHeight); } }
            internal Rectangle EditorBounds { get { return new Rectangle(EditorX, EditorY, EditorWidth, EditorHeight); } }
        }
        // name, skin image, x, y, width, height -- the x/y of a right-anchored control is resolved
        // from the panel width the same way the layout file's padding does.
        internal static readonly Field[] Fields = new[]
        {
            new Field("adv", "adv1.png", 2, 54, 336, 66),
            new Field("pictext", "pictext.png", 28, 130, 55, 40),
            new Field("picLine", "line.png", 10, 200, 325, 1),
            new Field("cmbQQUIN", "editbg", 96, 129, 150, 19),
            new Field("sedtPassword", "editbg", 96, 152, 150, 15),
            new Field("labRegiest", null, 266, 133, 0, 0),
            new Field("labForget", null, 266, 157, 0, 0),
            new Field("btnLogin", "Button_login.png", 96, 206, 64, 22),
            new Field("btnCancel", "Button_cancel.png", 190, 206, 64, 22),
            new Field("btnClose", "Button_close.png", Width - 6 - 13, 34, 13, 15),
        };
        internal static Field Find(string name)
        {
            foreach (var field in Fields) if (field.Name == name) return field;
            throw new ArgumentException("PANEL_FIELD_UNKNOWN");
        }
        /// <summary>
        /// The two fields the layout file declares as edit skins, in tab order, together with the
        /// sprite and editable rectangles each one must be laid out at.
        /// </summary>
        internal static IEnumerable<Field> SkinnedFields()
        {
            foreach (var field in Fields) if (field.Skinned) yield return field;
        }
    }

    /// <summary>A button drawn from the original three-state image series (normal, hover, down).</summary>
    internal sealed class ImageButton : Button
    {
        private readonly Image normal, hover, down;
        private Image current;
        internal ImageButton(string name, Image normalImage, Image hoverImage, Image downImage,
            int x, int y, int width, int height)
        {
            Name = name; normal = normalImage; hover = hoverImage; down = downImage;
            SetBounds(x, y, width, height);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            FlatAppearance.MouseOverBackColor = Color.Transparent;
            FlatAppearance.MouseDownBackColor = Color.Transparent;
            BackColor = Color.Transparent;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            current = normal;
            TabStop = false;
        }
        protected override void OnMouseEnter(EventArgs e) { current = hover; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { current = normal; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { current = down; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { current = hover; Invalidate(); base.OnMouseUp(e); }
        protected override void OnPaint(PaintEventArgs e)
        {
            // WinForms paints a default/focused button frame even with BorderSize=0.
            // The original PNG already contains the complete border and alpha edge.
            LoginSkinPaint.SpriteBackground(this, e.Graphics);
            e.Graphics.DrawImageUnscaled(current, 0, 0);
        }
        protected override void OnPaintBackground(PaintEventArgs e) { LoginSkinPaint.Background(this, e, InvokeParentBackground); }
        private void InvokeParentBackground(PaintEventArgs e) { InvokePaintBackground(Parent, e); }
    }

    // ButtonBase's transparent background path can leave a black buffer beneath
    // partially transparent PNG pixels. Paint the same parent skin first, then
    // source-over the sprite once, at its native size.
    internal static class LoginSkinPaint
    {
        internal static void SpriteBackground(Control control, Graphics graphics)
        {
            if (control.Parent == null) return;
            if (control.BackColor.A == 255) {
                using (var solid = new SolidBrush(control.BackColor)) graphics.FillRectangle(solid, control.ClientRectangle);
                return;
            }
            using (var fill = new SolidBrush(control.Parent.BackColor)) graphics.FillRectangle(fill, control.ClientRectangle);
            if (control.Parent.BackgroundImage != null)
                graphics.DrawImageUnscaled(control.Parent.BackgroundImage, -control.Left, -control.Top);
        }
        internal static void Background(Control control, PaintEventArgs e, Action<PaintEventArgs> paintParent)
        {
            if (control.Parent == null) return;
            var state = e.Graphics.Save();
            try {
                e.Graphics.TranslateTransform(-control.Left, -control.Top);
                paintParent(new PaintEventArgs(e.Graphics, control.Bounds));
            } finally { e.Graphics.Restore(state); }
        }
    }

    internal sealed class SkinCheckBox : CheckBox
    {
        private Bitmap[] images;
        private bool hot;
        internal SkinCheckBox()
        {
            AutoSize = false; BackColor = Color.Transparent;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
        }
        internal void UseSkin(UIResources ui)
        {
            images = new Bitmap[4];
            for (int n = 0; n < images.Length; n++) {
                images[n] = new Bitmap(ui.Image("Button_check_0" + n + ".bmp"));
                images[n].MakeTransparent(Color.Magenta);
            }
        }
        protected override void OnMouseEnter(EventArgs e) { hot = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hot = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnCheckedChanged(EventArgs e) { Invalidate(); base.OnCheckedChanged(e); }
        protected override void OnPaintBackground(PaintEventArgs e) { LoginSkinPaint.Background(this, e, InvokeParentBackground); }
        private void InvokeParentBackground(PaintEventArgs e) { InvokePaintBackground(Parent, e); }
        protected override void OnPaint(PaintEventArgs e)
        {
            LoginSkinPaint.SpriteBackground(this, e.Graphics);
            if (images != null) e.Graphics.DrawImageUnscaled(images[(Checked ? 2 : 0) + (hot ? 1 : 0)], 0, 0);
            TextRenderer.DrawText(e.Graphics, Text, Font, new Rectangle(21, 0, Width - 21, Height), ForeColor,
                TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter);
        }
        protected override void Dispose(bool disposing) { if (disposing && images != null) foreach (var image in images) image.Dispose(); base.Dispose(disposing); }
    }

    /// <summary>
    /// One of the client's own two-state edit skins, drawn at the sprite's natural 158x19 size.
    /// It is a sibling control placed behind its editor, not a parent of it: the editor is what
    /// receives text and focus, and the skin only ever supplies the frame. Its images are drawn
    /// 1:1, so the frame's border is exactly the art's border and nothing overlaps it.
    /// </summary>
    internal sealed class EditSkin : Control
    {
        private readonly Image normal, focused;
        private bool hot;
        internal EditSkin(string name, Image normalImage, Image focusedImage, Rectangle bounds)
        {
            Name = name; normal = normalImage; focused = focusedImage;
            SetBounds(bounds.X, bounds.Y, bounds.Width, bounds.Height);
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Enabled = false;
            TabStop = false;
        }
        internal bool Hot { get { return hot; } set { if (hot == value) return; hot = value; Invalidate(); } }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.DrawImageUnscaled(hot ? focused : normal, 0, 0);
        }
    }

    /// <summary>
    /// The window's visible shape, taken from the alpha channel of the client's own
    /// `loginbg.png`. The panel's art is a shaped skin: 7992 of its 82280 pixels are fully
    /// transparent (the band behind the logo and the four rounded corners) and the remaining
    /// alpha values in the whole file are 223 and 233, so the silhouette the region reproduces
    /// is byte-for-byte the art's own outline rather than an approximation of it.
    ///
    /// A region is used instead of a colour key because a key would have to be a colour that
    /// occurs nowhere in the art, and the 54 semi-transparent edge pixels would then blend
    /// towards that key and draw a coloured fringe around the logo. The cost of the region is
    /// that those 54 pixels - all at 87% opacity or more, all on the outer contour - composite
    /// over the panel's own background colour instead of the desktop. `MeasureEdgeCost` reports
    /// the worst case that costs, so the approximation is a number rather than a claim.
    /// </summary>
    internal static class WindowSilhouette
    {
        internal static Region FromAlpha(Bitmap image)
        {
            if (image.PixelFormat != PixelFormat.Format32bppArgb) throw new ArgumentException("SILHOUETTE_FORMAT");
            var path = new GraphicsPath();
            var data = image.LockBits(new Rectangle(0, 0, image.Width, image.Height),
                ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                var buffer = new byte[data.Stride * image.Height];
                Marshal.Copy(data.Scan0, buffer, 0, buffer.Length);
                for (int y = 0; y < image.Height; y++)
                {
                    int x = 0;
                    while (x < image.Width)
                    {
                        if (buffer[y * data.Stride + x * 4 + 3] == 0) { x++; continue; }
                        int start = x;
                        while (x < image.Width && buffer[y * data.Stride + x * 4 + 3] != 0) x++;
                        path.AddRectangle(new Rectangle(start, y, x - start, 1));
                    }
                }
            }
            finally { image.UnlockBits(data); }
            return new Region(path);
        }
        /// <summary>
        /// The largest per-channel difference the region costs on the semi-transparent contour:
        /// a pixel at alpha `a` is drawn as `a*art + (1-a)*background`, where a layered window
        /// would draw `a*art + (1-a)*desktop`. Over a black desktop the difference is at most
        /// `(1-a)*background`. Returns the count of affected pixels and that bound.
        /// </summary>
        internal static void MeasureEdgeCost(Bitmap image, Color background, out int partial, out int worstChannel)
        {
            partial = 0; worstChannel = 0;
            for (int y = 0; y < image.Height; y++)
                for (int x = 0; x < image.Width; x++)
                {
                    int a = image.GetPixel(x, y).A;
                    if (a == 0 || a == 255) continue;
                    partial++;
                    int room = 255 - a;
                    foreach (int channel in new[] { background.R, background.G, background.B })
                    {
                        int cost = room * channel / 255;
                        if (cost > worstChannel) worstChannel = cost;
                    }
                }
        }
    }
    /// <summary>
    /// The login client process, and the seam the tests replace instead of the form's own events.
    ///
    /// Geometry comes from res/Plugins/PetLogin/UI/LoginDlg.xml: the window is 340x242 with its
    /// background in loginbg.png, adv1.png at (2,54), pictext.png at (28,130), line.png at
    /// (10,200), the account field at (96,129) 150x19, the password field at (96,152) 150x15, the
    /// 64x22 buttons at (96,206) and (190,206), the 申请帐号 and 忘记密码 links at (266,133) and
    /// (266,157), and the 13x15 close glyph six pixels from the right edge at y=34. The top 53
    /// pixels are the window's drag area, as the original hotspot is.
    ///
    /// Auto login includes the protected saved password. The second original
    /// checkbox position is used for the separately requested startup option.
    /// </summary>
    internal interface ILoginClient
    {
        bool HasExited { get; }
        int ExitCode { get; }
        void WaitForExit();
    }
    internal sealed class LoginClient : ILoginClient
    {
        private readonly Process process;
        private int exitCode;
        private bool exited;
        internal LoginClient(Process process) { this.process = process; }
        public bool HasExited { get { return exited || process.HasExited; } }
        public int ExitCode { get { return exited ? exitCode : process.ExitCode; } }
        public void WaitForExit() { process.WaitForExit(); exitCode = process.ExitCode; exited = true; process.Dispose(); }
    }
    // External service/process boundaries. Tests replace these, never the form's events or state.
    internal class LoginOperations
    {
        private readonly Options options;
        private bool prepared;
        internal Service Service;
        internal LoginOperations(Options options) { this.options = options; }
        internal virtual ServiceUrls Ready() { if (!prepared) { if (options.PrepareComplete != null) options.PrepareComplete(); prepared = true; } Service = new Service(options); return Service.Ready(); }
        private LauncherPreferences Preferences { get { return new LauncherPreferences(options.CompactPackage ? Path.Combine(options.StateDirectory,"preferences.bin") : Path.Combine(options.Root, "runtime", "state", "launcher", "preferences.bin")); } }
        internal virtual LoginPreferences LoadPreferences() {
            var value = Preferences.Load();
            if (!LauncherSettings.AutoLogin(options.Root, value.AutoLogin)) return new LoginPreferences();
            return value;
        }
        internal virtual void SavePreferences(LoginPreferences value) {
            Preferences.Save(value);
            LauncherSettings.Save(options.Root, value != null && value.AutoLogin);
        }
        internal virtual bool StartupEnabled() { return File.Exists(LauncherStartup.Shortcut(options.Root)); }
        internal virtual void SetStartup(bool enabled) { LauncherStartup.Set(options.Root, enabled); }
        internal virtual void Notify(string message) { MessageBox.Show(message, "QQ宠物", MessageBoxButtons.OK, MessageBoxIcon.Information); }
        internal virtual Service.LoginOutcome Authenticate(string user, string password, out byte[] packet, out string token)
        { return Service.Authenticate(user, password, out packet, out token); }
        internal virtual bool PetlessBoot(string token, out byte[] packet) { return Service.PetlessBoot(token, out packet); }
        internal virtual void Start(byte[] packet, Action<ILoginClient> started)
        {
            if (Process.GetProcessesByName("QQPenguin").Length != 0) throw new IOException("CLIENT_ALREADY_RUNNING");
            using (var pipe = new BootstrapPipe())
            {
                var info = new ProcessStartInfo(options.Client, "/n QQPenguin") {
                    WorkingDirectory = Path.GetDirectoryName(options.Client), UseShellExecute = false };
                info.EnvironmentVariables["QQPET_LOCAL_BOOTSTRAP_PIPE"] = pipe.Name;
                info.EnvironmentVariables["QQPET_LOCAL_BOOTSTRAP_OWNER"] = Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
                var process = Process.Start(info);
                started(new LoginClient(process));
                pipe.Deliver(process.Id, packet, 180000, () => process.HasExited);
            }
        }
        internal virtual void DisposeService() { if (Service != null) { Service.Dispose(); Service = null; } }
    }

    internal sealed class LoginForm : Form
    {
        private const int PanelWidth = LoginPanelLayout.Width, PanelHeight = LoginPanelLayout.Height,
            DragHeight = LoginPanelLayout.DragHeight;
        private readonly Options options;
        // Both fields are AutoSize=false single-line TextBoxes with no border of their own: the
        // frame is the client's own `editbg` skin, so a border drawn by the control as well would
        // be the second rectangle the user sees. Their bounds are the skin's inner field, not the
        // layout file's element rectangle, so neither the control's background nor its caret can
        // reach past the frame. The account list offers the protected remembered account.
        private readonly TextBox account = new TextBox { MaxLength = 10, AutoSize = false, BorderStyle = BorderStyle.None, BackColor = Color.White };
        private readonly TextBox password = new TextBox { MaxLength = 128, UseSystemPasswordChar = true, AutoSize = false, BorderStyle = BorderStyle.None, BackColor = Color.White };
        private readonly Label status = new Label { Name = "status", AutoSize = false };
        private readonly SkinCheckBox autoLogin = new SkinCheckBox { Name = "chkAutoLogin", Text = "自动登录" };
        private readonly SkinCheckBox startup = new SkinCheckBox { Name = "chkStartup", Text = "开机启动" };
        private LayeredLoginSkin layeredSkin;
        private Bitmap opaqueBackground;
        private bool autoAttempted, loadingPreferences;
        private readonly Dictionary<string, EditSkin> skins = new Dictionary<string, EditSkin>(StringComparer.Ordinal);
        // The page addresses the local service itself reported on its readiness line. Nothing
        // here is guessed from a port or an environment variable: a link exists only when the
        // service said it serves that page.
        private readonly Dictionary<string, string> pages = new Dictionary<string, string>(StringComparer.Ordinal);
        private readonly ImageButton login, cancel;
        private readonly object lifecycle = new object();
        private readonly LifecycleReport report;
        private readonly LoginOperations operations;
        private ILoginClient client;
        internal enum LoginState { Preparing, Ready, ConnectionUnavailable, Authenticating, AwaitingClient, ClientRunning, WaitingExit, Ended, Closing }
        internal LoginState State { get; private set; }
        private bool clientAttempted;
        private bool retryLoginAfterReady;
        private bool serviceReady;
        private int generation;
        private bool closing, canClose;
        // The panel is hidden only while the client it started is alive, and that is a state the
        // form owns rather than a side effect of a message: a late callback from a superseded
        // operation must never hide a panel the user is typing into, and must never bring back a
        // panel that was hidden because the client actually started.
        private bool panelHidden;
        internal bool PanelHidden { get { return panelHidden; } }
        internal LoginForm(Options options, UIResources ui, LoginOperations operations = null)
        {
            this.options = options;
            this.operations = operations ?? new LoginOperations(options);
            report = new LifecycleReport(options.Root, options.LifecycleReportFile);
            Text = "QQ宠物登录";
            FormBorderStyle = FormBorderStyle.None;
            // The panel is a fixed 1:1 skin: every control's rectangle is a pixel in the art, so
            // the form may not rescale itself from the ambient font or DPI. Without this the
            // fields move with the UI font while the background image does not, which is one way
            // an editor's frame ends up drawn where the skin no longer is.
            AutoScaleMode = AutoScaleMode.None;
            ClientSize = new Size(PanelWidth, PanelHeight);
            StartPosition = FormStartPosition.CenterScreen;
            // The panel's text is 宋体 9pt, the UI font of this client's own era, because it is
            // the one that fits: its line height is 13.69px against the 15px field the layout
            // file gives a text row, where the modern default (Microsoft YaHei UI at the same
            // 9pt) is 15.24px and would sit a fraction outside the frame's inner field.
            Font = new Font("宋体", 9F);
            // The art is a shaped skin, so the white the semi-transparent contour composites over
            // is the colour next to the art's own edge rather than the stock control grey.
            BackColor = LayeredLoginSkin.ClearKey;
            TransparencyKey = LayeredLoginSkin.ClearKey;
            var background = ui.Image(LoginPanelLayout.Background);
            if (background.Width < PanelWidth || background.Height < PanelHeight) throw new IOException("UI_RESOURCE_TOO_SMALL");
            opaqueBackground = LayeredLoginSkin.OpaqueInterior(background);
            BackgroundImage = opaqueBackground;
            BackgroundImageLayout = ImageLayout.None;
            layeredSkin = new LayeredLoginSkin(background);
            Icon = ui.Icon("penguin.ico") ?? SystemIcons.Application;
            // The panel's transparent band and rounded corners are the window's shape, taken from
            // the same buffer that is painted, so nothing outside the art is ever opaque.
            Region = WindowSilhouette.FromAlpha(background);
            Controls.Add(Picture(ui, LoginPanelLayout.Find("adv")));
            Controls.Add(Picture(ui, LoginPanelLayout.Find("pictext")));
            Controls.Add(Picture(ui, LoginPanelLayout.Find("picLine")));
            // One skin per edit field, from the client's own two-state series, drawn 1:1 behind
            // the editor it frames. The editor is what carries focus; the skin only follows it.
            foreach (var field in LoginPanelLayout.SkinnedFields())
            {
                var skin = new EditSkin("skin:" + field.Name, ui.Image("editbg_00.png"), ui.Image("editbg_01.png"), field.SkinBounds);
                skins[field.Name] = skin;
                Controls.Add(skin);
            }
            LoginPanelLayout.Field accountField = LoginPanelLayout.Find("cmbQQUIN");
            LoginPanelLayout.Field passwordField = LoginPanelLayout.Find("sedtPassword");
            account.Name = accountField.Name;
            password.Name = passwordField.Name;
            account.SetBounds(accountField.EditorX, accountField.EditorY, accountField.EditorBounds.Width, accountField.EditorBounds.Height);
            account.TabIndex = 1;
            password.SetBounds(passwordField.EditorX, passwordField.EditorY, passwordField.EditorBounds.Width, passwordField.EditorBounds.Height);
            password.TabIndex = 2;
            // The editor shows the focused skin while it holds the caret, so the field the user is
            // typing into is the one the client's own art marks as active.
            account.Enter += delegate { Focus(accountField.Name, true); };
            account.Leave += delegate { Focus(accountField.Name, false); };
            password.Enter += delegate { Focus(passwordField.Name, true); };
            password.Leave += delegate { Focus(passwordField.Name, false); };
            // Between the password field (bottom 168) and the separator at y=200: the band the
            // original panel gave its two checkboxes, which this build does not draw.
            status.SetBounds(20, 170, 300, 28);
            status.BackColor = Color.Transparent;
            status.ForeColor = Color.FromArgb(0x8e, 0x58, 0x0a);
            status.Text = "";
            status.Visible = false;
            autoLogin.UseSkin(ui); startup.UseSkin(ui);
            // Both options share the input area's left and right edges.
            int optionWidth = 21 + TextRenderer.MeasureText(autoLogin.Text, Font, Size.Empty,
                TextFormatFlags.NoPadding | TextFormatFlags.SingleLine).Width;
            autoLogin.SetBounds(accountField.X, 177, optionWidth, 17);
            startup.SetBounds(accountField.X + accountField.W - optionWidth, 177, optionWidth, 17);
            autoLogin.ForeColor = startup.ForeColor = Color.FromArgb(0x8e, 0x58, 0x0a);
            autoLogin.TabIndex = 3; startup.TabIndex = 4;
            loadingPreferences = true;
            var preferences = this.operations.LoadPreferences();
            autoLogin.Checked = preferences.AutoLogin;
            if (preferences.AutoLogin) { account.Text = preferences.Account ?? ""; password.Text = preferences.Password ?? ""; }
            startup.Checked = this.operations.StartupEnabled();
            loadingPreferences = false;
            autoLogin.CheckedChanged += delegate { if (!loadingPreferences && !autoLogin.Checked) this.operations.SavePreferences(new LoginPreferences()); };
            startup.CheckedChanged += delegate {
                if (loadingPreferences) return;
                try { this.operations.SetStartup(startup.Checked); }
                catch { loadingPreferences = true; startup.Checked = !startup.Checked; loadingPreferences = false; MessageBox.Show(this, "开机启动设置未能保存，请重试。", "QQ宠物", MessageBoxButtons.OK, MessageBoxIcon.Information); }
            };
            LoginPanelLayout.Field loginField = LoginPanelLayout.Find("btnLogin");
            LoginPanelLayout.Field cancelField = LoginPanelLayout.Find("btnCancel");
            LoginPanelLayout.Field closeField = LoginPanelLayout.Find("btnClose");
            login = new ImageButton(loginField.Name, ui.Image("Button_login_00.png"), ui.Image("Button_login_01.png"),
                ui.Image("Button_login_02.png"), loginField.X, loginField.Y, loginField.W, loginField.H);
            cancel = new ImageButton(cancelField.Name, ui.Image("Button_cancel_00.png"), ui.Image("Button_cancel_01.png"),
                ui.Image("Button_cancel_02.png"), cancelField.X, cancelField.Y, cancelField.W, cancelField.H);
            var close = new ImageButton(closeField.Name, ui.Image("Button_close_00.png"), ui.Image("Button_close_01.png"),
                ui.Image("Button_close_02.png"), closeField.X, closeField.Y, closeField.W, closeField.H);
            close.Click += delegate { Close(); };
            LoginPanelLayout.Field registerField = LoginPanelLayout.Find("labRegiest");
            LoginPanelLayout.Field forgetField = LoginPanelLayout.Find("labForget");
            var register = Link(registerField, "注册账号");
            register.Click += delegate { MessageBox.Show(this, "请联系管理员注册账号。", "注册账号", MessageBoxButtons.OK, MessageBoxIcon.Information); };
            var forget = Link(forgetField, "忘记密码");
            forget.Click += delegate { MessageBox.Show(this, "请联系管理员重置密码。", "忘记密码", MessageBoxButtons.OK, MessageBoxIcon.Information); };
            Controls.AddRange(new Control[] { account, password, status, autoLogin, startup, login, cancel, close, register, forget });
            account.BringToFront(); password.BringToFront();
            AcceptButton = login; CancelButton = cancel;
            // Opening the manual panel performs no transport operation.
            State = LoginState.Ready;
            login.Enabled = true;
            login.Click += Login;
            cancel.Click += delegate { Close(); };
            MouseDown += DragPanel;
            Shown += delegate {
                Owner = layeredSkin; layeredSkin.Place(this);
                if (autoLogin.Checked && account.Text.Length != 0 && password.Text.Length != 0) {
                    autoAttempted = true; BeginInvoke((Action)(() => Login(login, EventArgs.Empty)));
                }
            };
            LocationChanged += delegate { if (layeredSkin != null && IsHandleCreated && Visible) layeredSkin.Place(this); };
            VisibleChanged += delegate { if (layeredSkin != null && layeredSkin.IsHandleCreated) layeredSkin.Place(this); };
            FormClosing += HandleClosing;
        }

        private static PictureBox Picture(UIResources ui, LoginPanelLayout.Field field)
        {
            var image = ui.Image(field.Image);
            // The layout file's own size wins; the image is only checked to be at least that big.
            if (image.Width < field.W || image.Height < field.H) throw new IOException("UI_RESOURCE_TOO_SMALL");
            var box = new PictureBox { Name = field.Name, Image = image, BackColor = Color.Transparent, Enabled = false };
            box.SetBounds(field.X, field.Y, field.W, field.H);
            return box;
        }
        private static Label Link(LoginPanelLayout.Field field, string text)
        {
            // The link text is data, so the label sizes itself, but its box is bounded by the
            // panel: at the panel's own 9pt font the text is 54px against the 74px the layout
            // file leaves to the right edge, and a wider font clips at the edge instead of
            // drawing past the window.
            return new Label { Name = field.Name, Text = text, Location = new Point(field.X, field.Y),
                AutoSize = false, Size = new Size(LoginPanelLayout.Width - field.X, 20),
                TextAlign = ContentAlignment.TopLeft,
                ForeColor = Color.FromArgb(0x20, 0x88, 0xba), BackColor = Color.Transparent,
                Cursor = Cursors.Hand };
        }
        // The skin follows the editor's focus. Only the skin changes: the editors' geometry and
        // contents are the same whether or not the field is active.
        private void Focus(string field, bool active)
        {
            EditSkin skin;
            if (skins.TryGetValue(field, out skin)) skin.Hot = active;
        }
        // The panel has no caption, so the title area drags the window exactly as the original
        // hotspot does.
        private void DragPanel(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left || e.Y > DragHeight) return;
            ReleaseCapture();
            SendMessage(Handle, 0xA1, (IntPtr)0x2, IntPtr.Zero);
        }
        [DllImport("user32.dll")] private static extern bool ReleaseCapture();
        [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr handle, int message, IntPtr wParam, IntPtr lParam);

        // The link targets are the addresses the local service reported on its readiness line, so
        // a link is only ever live when the service actually serves that page on the port it
        // actually bound. Without the address the reason is stated instead of doing nothing.
        private void OpenLocalPage(string key, string missingMessage)
        {
            string url;
            if (!pages.TryGetValue(key, out url) || string.IsNullOrEmpty(url)
                || !(url.StartsWith("http://127.0.0.1:", StringComparison.Ordinal)
                    || url.StartsWith("http://localhost:", StringComparison.Ordinal)))
            { operations.Notify("请稍后重试，或联系管理员办理。 "); return; }
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch { operations.Notify("页面暂时无法打开，请稍后重试。"); }
        }
        private void ApplyUrls(ServiceUrls urls)
        {
            if (urls == null) return;
            pages["register"] = urls.Register; pages["reset"] = urls.Reset; pages["adopt"] = urls.Adopt;
        }
        private void Display(Action action)
        {
            int version = generation;
            if (!IsDisposed && IsHandleCreated) try { BeginInvoke(new Action(() => {
                if (!IsDisposed && !closing && version == generation) action();
            })); } catch (InvalidOperationException) { }
        }
        /// <summary>
        /// Record one snapshot and remember whether it reached the disk. The launcher's own state
        /// file is the only thing an external reader can see, so a write that did not commit is a
        /// failure of this attempt and not a detail to swallow: a later successful write does not
        /// clear it, and the process exit code carries it outward when the file itself cannot.
        /// </summary>
        private bool Record(string phase, string error = null, int? nativeExitCode = null)
        {
            return report.Write(phase, error, nativeExitCode);
        }
        /// <summary>True when a state change of this attempt could not be committed.</summary>
        internal bool ReportFailed { get { return report.HasFailed || !report.HasCommitted; } }
        private void SetState(LoginState state, string message)
        {
            if (IsDisposed) return;
            if (panelHidden && state == LoginState.ClientRunning) return;
            State = state; status.Text = ""; status.Visible = false;
            if (state == LoginState.Ready && message.StartsWith("账号或密码", StringComparison.Ordinal)) operations.Notify("账号或密码不正确，请重试。");
            if (state == LoginState.Ended) operations.Notify("暂时无法连接，请检查连接后重新打开登录器。");
            if (state == LoginState.WaitingExit) operations.Notify("请先退出宠物，再关闭登录器。");
            bool editable = state == LoginState.Preparing || state == LoginState.Ready || state == LoginState.ConnectionUnavailable;
            autoLogin.Enabled = startup.Enabled = editable;
            account.Enabled = password.Enabled = true;
            account.ReadOnly = password.ReadOnly = !editable;
            login.Enabled = state == LoginState.Ready || state == LoginState.ConnectionUnavailable;
            cancel.Enabled = true;
            if (!editable) password.Clear();
            // Hiding and re-showing is part of the state transition, not a side effect of a
            // message: the panel is down exactly while the client it started owns the session,
            // and every other state - a refused login, a failed handover, a client that has
            // exited - brings it back so there is always a visible place to act from.
            if (state == LoginState.ClientRunning) HidePanel();
            else ShowPanel();
        }
        /// <summary>
        /// The panel goes away once the client process is up and the bootstrap packet has been
        /// accepted by its pipe reader. That is the strongest signal this launcher has, and it
        /// proves exactly this much: one client process is alive and took the packet. It is not
        /// proof that a pet reached the desktop, so the service and the client's ownership of
        /// this session are kept exactly as they were, the launcher waits for the owned client to exit before closing itself.
        /// </summary>
        private void HidePanel()
        {
            if (panelHidden || IsDisposed) return;
            panelHidden = true;
            // Visibility only. The record's outcome fields - the phase that says what happened to
            // the client, its error code and its exit code - are written by the thread that owns
            // the client and are re-emitted unchanged here, so hiding the panel can never turn a
            // finished entry into a panel event.
            report.Note(false);
            Hide();

        }
        /// <summary>
        /// Re-showing is a user action or a state change, never a late callback: RestorePanel is
        /// reached from the states above, and both are refused while the
        /// client is the state's owner, so a delayed result from a superseded operation cannot
        /// pull the panel back over a session that has already started.
        /// </summary>
        private void ShowPanel()
        {
            if (!panelHidden) return;
            panelHidden = false;
            report.Note(true);
            if (!Visible) Show();
            Activate();
        }
        private void StartService()
        {
            Record("starting-service");
            try
            {
                ServiceUrls urls;
                lock (lifecycle) { if (closing) return; }
                urls = operations.Ready();
                serviceReady = true;
                if (closing || IsDisposed) { operations.DisposeService(); return; }
                Record("waiting-for-credentials");
                Display(() => { ApplyUrls(urls); SetState(LoginState.Ready, ""); account.Focus();
                    if (retryLoginAfterReady || (!autoAttempted && autoLogin.Checked && account.Text.Length != 0 && password.Text.Length != 0)) { retryLoginAfterReady=false; autoAttempted = true; Login(login, EventArgs.Empty); }
                });
            }
            catch (Exception error) {
                serviceReady = false;
                string code = error.Message;
                if (!System.Text.RegularExpressions.Regex.IsMatch(code,"^[A-Z_]{1,40}$")) code="REMOTE_CONNECTION_FAILED";
                Record("failed",options.RemoteConfig!=null?"AUTHENTICATION_CHANNEL_FAILED":"SERVICE_START_FAILED");
                Display(() => {
                    retryLoginAfterReady=false;
                    if(options.RemoteConfig!=null) {
                        SetState(LoginState.ConnectionUnavailable,"");
                        operations.Notify(code=="REMOTE_CERTIFICATE_MISMATCH" ? "客户端与服务端的连接配置不一致。请用同一套 IP 工具修改并重新分发客户端。" : code.StartsWith("COMPLETE_",StringComparison.Ordinal) ? "客户端文件校验未通过，请重新解压完整交付版。（"+code+"）" : "连接未完成，请检查服务端地址和网络后，再点击登录重试。（"+code+"）");
                    } else SetState(LoginState.Ended,"未连接到服务端，请检查后重新打开登录器。");
                });
            }
        }
        private void Login(object sender, EventArgs args)
        {
            if ((State != LoginState.Ready && State != LoginState.ConnectionUnavailable) || closing || clientAttempted) return;
            string user = account.Text.Trim(); uint parsed;
            if (!UInt32.TryParse(user, NumberStyles.None, CultureInfo.InvariantCulture, out parsed) || parsed == 0 || password.Text.Length == 0)
            { password.Clear(); operations.Notify("请输入有效账号和密码。"); return; }
            if (!serviceReady) {
                retryLoginAfterReady = true; SetState(LoginState.Preparing, "");
                Task.Run(() => { operations.DisposeService(); StartService(); }); return;
            }
            string passwordHex;
            var remembered = autoLogin.Checked ? new LoginPreferences { AutoLogin = true, Account = user, Password = password.Text } : new LoginPreferences();
            try { passwordHex = Wire.Password(password.Text); }
            catch (ArgumentException) { operations.Notify("密码长度不符合要求。"); return; }
            finally { password.Clear(); }
            SetState(LoginState.Authenticating, "正在验证本地账号…");
            Record("authenticating");
            Task.Run(() =>
            {
                byte[] packet = null;
                try
                {
                    string token;
                    var outcome = operations.Authenticate(user, passwordHex, out packet, out token);
                    passwordHex = null; user = null;
                    if (closing || IsDisposed) return;
                    if (outcome == Service.LoginOutcome.Rejected)
                    {
                        operations.SavePreferences(new LoginPreferences());
                        Record("authentication-rejected", "AUTH_FAILED");
                        Display(() => SetState(LoginState.Ready, "账号或密码不正确，请重试。")); return;
                    }
                    if (outcome == Service.LoginOutcome.Petless)
                    {
                        if (packet != null) Array.Clear(packet, 0, packet.Length);
                        packet = null;
                        if (string.IsNullOrEmpty(token) || !operations.PetlessBoot(token, out packet) || packet == null)
                        {
                            Record("petless-boot-unavailable", "PETLESS_BOOT_FAILED");
                            Display(() => SetState(LoginState.Ready, "启动凭据未能取得，客户端没有启动。请重试登录。")); return;
                        }
                    }
                    operations.SavePreferences(remembered);
                    remembered.Password = null; remembered.Account = null;
                    StartEntry(packet);
                }
                catch
                {
                    if (!closing) Record("failed", "AUTHENTICATION_CHANNEL_FAILED");
                    serviceReady = false;
                    operations.DisposeService();
                    Display(() => { SetState(LoginState.ConnectionUnavailable, "");
                        operations.Notify("登录连接中断，请检查服务端后点击登录重试。"); });
                }
                finally { if (packet != null) Array.Clear(packet, 0, packet.Length); passwordHex = null; user = null; remembered.Password = null; remembered.Account = null; }
            });
        }
        // The historical adoption window, kept as the older route's own implementation and no
        // longer called from the login path: the decided route starts the client and lets its own
        // window do the choosing, and a failure to start that route leaves the account petless on
        // the login panel instead of opening this window. A build that wants it back has to wire it
        // explicitly - it is never a fallback. Its outcome is one of: adopted (the entry continues),
        // cancelled (the account stays petless and the panel stays operable), or failed (the reason
        // is stated and the account stays petless).
        private void ShowAdoption(string adoptToken)
        {
            using (var dialog = new AdoptionForm(operations.Service, adoptToken, Path.Combine(options.Root, "Adopt.swf")))
            {
                dialog.ShowDialog(this);
                if (!dialog.Adopted)
                {
                    status.Text = dialog.Failure != null
                        ? "领养窗口未能打开：" + dialog.Failure + "。账号保持没有宠物的状态。"
                        : "已取消领养；账号保持没有宠物的状态，可重新登录后再试。";
                    login.Enabled = true; account.Enabled = true; password.Enabled = true; password.Focus();
                    return;
                }
                byte[] packet = dialog.Packet;
                Task.Run(() => StartEntry(packet));
            }
        }
        // Everything an entry shares, whatever produced its bootstrap packet: start the client,
        // deliver the packet, and own the client's lifetime and the service teardown.
        private void StartEntry(byte[] packet)
        {
            // The record has to be committable before a client is started, because after a start
            // there would be nothing a reader could be told. This is a refusal to begin, not a
            // failure of an attempt - and it is decided *outside* the entry's own try/finally, so
            // the teardown that ends an attempt cannot run for an attempt that never started: the
            // one-start allowance is not spent, the service stays up, and the user can retry once
            // the disk problem is gone.
            if (!Record("starting-client"))
            {
                if (packet != null) Array.Clear(packet, 0, packet.Length);
                Display(() => SetState(LoginState.Ready,
                    "状态记录无法写入磁盘，客户端没有启动。请检查磁盘空间与权限后重试。"));
                return;
            }
            bool delivered = false; string failure = null;
            try
            {
                lock (lifecycle)
                {
                    if (closing || clientAttempted) return;
                    clientAttempted = true; // One Process.Start attempt per coordinator reservation, including failures.
                }
                operations.Start(packet, started => {
                    lock (lifecycle) { client = started; }
                    Record("awaiting-bootstrap");
                    Display(() => SetState(LoginState.AwaitingClient, "客户端已启动，正在交接。若交接失败，请先退出客户端。"));
                });
                delivered = true; Record("client-running");
                Display(() => SetState(LoginState.ClientRunning, "客户端运行中。请先退出客户端，再关闭本次登录器。"));
            }
            catch
            {
                failure = client == null ? "CLIENT_START_FAILED" : "BOOTSTRAP_FAILED";
                Record("failed", failure);
                Display(() => SetState(client == null ? LoginState.Ended : LoginState.WaitingExit,
                    client == null ? "启动未完成。本次启动额度已使用，请关闭并从协调入口重新发起。" : "登录交接未完成。请先退出客户端，本次登录器不能再次启动。"));
            }
            finally
            {
                if (packet != null) Array.Clear(packet, 0, packet.Length);
                int exit = -1;
                if (client != null) { try { client.WaitForExit(); exit = client.ExitCode; } catch { } }
                operations.DisposeService();
                if (delivered && exit == 0) Record("client-exited", null, exit);
                else Record("failed", failure ?? "CLIENT_EXITED_WITH_ERROR", exit);
                // The owned client has exited; service disposal and final report precede UI closure.
                Display(() => { canClose = true; State = LoginState.Ended; Close(); });
            }
        }
        private void HandleClosing(object sender, FormClosingEventArgs args)
        {
            if (canClose) { closing = true; generation++; return; }
            args.Cancel = true;
            lock (lifecycle)
            {
                if (clientAttempted && !canClose)
                {
                    SetState(LoginState.WaitingExit, "请先退出客户端并等待服务结束，再关闭登录器。"); return;
                }
                if (closing) return;
                closing = true; generation++;
            }
            SetState(LoginState.Closing, options.ServicePipe == null ? "正在关闭本地服务…" : "正在退出登录器…");
            Record("stopping");
            Task.Run(() => { operations.DisposeService(); Record("stopped");
                if (!IsDisposed && IsHandleCreated) try { BeginInvoke(new Action(() => { if (!IsDisposed) { canClose = true; Close(); } })); } catch (InvalidOperationException) { }
            });
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                closing = true; generation++; password.Clear();
                if (!clientAttempted) operations.DisposeService();
                if (layeredSkin != null) { Owner = null; layeredSkin.Dispose(); layeredSkin = null; }
                if (opaqueBackground != null) { BackgroundImage = null; opaqueBackground.Dispose(); opaqueBackground = null; }
            }
            base.Dispose(disposing);
        }
    }
}
