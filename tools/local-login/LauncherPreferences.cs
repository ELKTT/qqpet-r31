using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

namespace QQPet.LocalLogin
{
    internal static class LauncherSettings
    {
        internal static string FileName(string root) { return Path.Combine(root, "launcher.ini"); }
        internal static bool AutoLogin(string root, bool fallback)
        {
            string file = FileName(root);
            try {
                if (!File.Exists(file)) return fallback;
                if (new FileInfo(file).Length > 4096 || (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) return false;
                bool section = false;
                foreach (string raw in File.ReadAllLines(file, Encoding.UTF8)) {
                    string line = raw.Trim();
                    if (line.StartsWith("[") && line.EndsWith("]")) { section = String.Equals(line, "[Launcher]", StringComparison.OrdinalIgnoreCase); continue; }
                    int at = line.IndexOf('=');
                    if (section && at > 0 && String.Equals(line.Substring(0, at).Trim(), "AutoLogin", StringComparison.OrdinalIgnoreCase))
                        return line.Substring(at + 1).Trim() == "1";
                }
                return false;
            } catch (IOException) { return false; } catch (UnauthorizedAccessException) { return false; }
        }
        internal static void Save(string root, bool enabled)
        {
            string file = FileName(root), temporary = file + ".pending-" + Guid.NewGuid().ToString("N");
            if (File.Exists(file) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("SETTINGS_LINK_REFUSED");
            try {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                    byte[] bytes = Encoding.UTF8.GetBytes("; AutoLogin: 1=enabled, 0=manual login. No passwords are stored here.\r\n[Launcher]\r\nAutoLogin=" + (enabled ? "1" : "0") + "\r\n");
                    stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
                }
                if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
            } finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
    }
    internal sealed class LoginPreferences
    {
        public bool AutoLogin { get; set; }
        public string Account { get; set; }
        public string Password { get; set; }
    }
    // One opt-in controls both remembering the password and automatic submission.
    // The whole record is protected for the current Windows user, never logged.
    internal sealed class LauncherPreferences
    {
        private readonly string file;
        private readonly byte[] entropy = Encoding.UTF8.GetBytes("QQPet-launcher-preferences-v1");
        internal LauncherPreferences(string file) { this.file = Path.GetFullPath(file); }
        internal LoginPreferences Load()
        {
            try {
                if (!File.Exists(file) || new FileInfo(file).Length > 65536 || (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) return new LoginPreferences();
                byte[] plain = ProtectedData.Unprotect(File.ReadAllBytes(file), entropy, DataProtectionScope.CurrentUser);
                try {
                    var p = Wire.Serializer().Deserialize<LoginPreferences>(Encoding.UTF8.GetString(plain));
                    uint number;
                    if (p == null || !p.AutoLogin || !UInt32.TryParse(p.Account, out number) || number == 0 || String.IsNullOrEmpty(p.Password) || Encoding.UTF8.GetByteCount(p.Password) > 128) return new LoginPreferences();
                    return p;
                } finally { Array.Clear(plain, 0, plain.Length); }
            } catch (CryptographicException) { return new LoginPreferences(); }
              catch (IOException) { return new LoginPreferences(); }
              catch (UnauthorizedAccessException) { return new LoginPreferences(); }
              catch (ArgumentException) { return new LoginPreferences(); }
              catch (InvalidOperationException) { return new LoginPreferences(); }
        }
        internal void Save(LoginPreferences p)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            if (File.Exists(file) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("PREFERENCES_LINK_REFUSED");
            if (p == null || !p.AutoLogin) p = new LoginPreferences();
            byte[] plain = Encoding.UTF8.GetBytes(Wire.Serializer().Serialize(p));
            string temporary = file + ".pending-" + Guid.NewGuid().ToString("N");
            try {
                byte[] encrypted = ProtectedData.Protect(plain, entropy, DataProtectionScope.CurrentUser);
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(encrypted, 0, encrypted.Length); stream.Flush(true); }
                if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
            } finally { Array.Clear(plain, 0, plain.Length); if (File.Exists(temporary)) File.Delete(temporary); }
        }
    }
    internal static class LauncherStartup
    {
        internal static string Shortcut(string root)
        {
            byte[] hash;
            using (var digest = SHA256.Create()) hash = digest.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(root).ToUpperInvariant()));
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "QQ宠物-" + BitConverter.ToString(hash, 0, 6).Replace("-", "") + ".lnk");
        }
        internal static void Set(string root, bool enabled)
        {
            string file = Shortcut(root);
            string executable = Path.Combine(root, "QQ宠物.exe");
            if (!File.Exists(executable)) executable = Application.ExecutablePath;
            SetFile(file, executable, root, enabled);
        }
        // The exact same shortcut implementation is exercised against a private
        // synthetic directory; tests never touch the user's Startup directory.
        internal static void SetFile(string file, string executable, string root, bool enabled)
        {
            if (!enabled) { if (File.Exists(file)) File.Delete(file); return; }
            var type = Type.GetTypeFromProgID("WScript.Shell", true);
            dynamic shell = Activator.CreateInstance(type), link = null;
            try {
                link = shell.CreateShortcut(file);
                link.TargetPath = executable;
                link.WorkingDirectory = root; link.Description = "QQ宠物"; link.IconLocation = link.TargetPath + ",0"; link.Save();
            } finally { if (link != null) System.Runtime.InteropServices.Marshal.FinalReleaseComObject(link); System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); }
        }
    }
}
