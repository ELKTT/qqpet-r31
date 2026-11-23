using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace QQPet.LocalLogin
{
    internal static class Wire
    {
        internal const int MaximumLine = 4096;
        internal static JavaScriptSerializer Serializer()
        {
            return new JavaScriptSerializer { MaxJsonLength = MaximumLine, RecursionLimit = 8 };
        }
        internal static Dictionary<string, object> Read(StreamReader reader)
        {
            var line = new StringBuilder();
            int consumed = 0;
            for (;;)
            {
                int c = reader.Read();
                if (c == -1) throw new IOException("SERVICE_EOF");
                if (c == '\n') break;
                if (++consumed > MaximumLine) throw new IOException("SERVICE_LINE_LIMIT");
                if (c == '\r') continue;
                line.Append((char)c);
            }
            var value = Serializer().DeserializeObject(line.ToString()) as Dictionary<string, object>;
            if (value == null) throw new IOException("SERVICE_MESSAGE_INVALID");
            return value;
        }
        internal static byte[] Hex(string text, int maxBytes, bool exact)
        {
            if (text == null || text.Length % 2 != 0 || text.Length > maxBytes * 2 || (exact && text.Length != maxBytes * 2))
                throw new IOException("SERVICE_FIELD_INVALID");
            var result = new byte[text.Length / 2];
            for (int i = 0; i < result.Length; i++)
                if (!Byte.TryParse(text.Substring(i * 2, 2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out result[i]))
                    throw new IOException("SERVICE_FIELD_INVALID");
            return result;
        }
        internal static byte[] Bootstrap(Dictionary<string, object> value)
        {
            object raw;
            if (value.Count != 5 || !value.TryGetValue("ok", out raw) || !(raw is bool) || !(bool)raw)
                throw new IOException("SERVICE_LOGIN_INVALID");
            if (!value.TryGetValue("uin", out raw) || !(raw is int || raw is long || raw is decimal))
                throw new IOException("SERVICE_FIELD_INVALID");
            decimal number = Convert.ToDecimal(raw, CultureInfo.InvariantCulture);
            if (number < 1 || number > UInt32.MaxValue || Decimal.Truncate(number) != number)
                throw new IOException("SERVICE_FIELD_INVALID");
            byte[] pet = null, sign = null, nickname = null;
            try
            {
                pet = Hex(value.ContainsKey("petIdHex") ? value["petIdHex"] as string : null, 8, true);
                sign = Hex(value.ContainsKey("signHex") ? value["signHex"] as string : null, 32, true);
                nickname = Hex(value.ContainsKey("nicknameHex") ? value["nicknameHex"] as string : null, 16, false);
                var packet = new byte[96];
                Buffer.BlockCopy(Encoding.ASCII.GetBytes("QPL1"), 0, packet, 0, 4);
                uint uin = (uint)number;
                for (int i = 0; i < 4; i++) packet[4 + i] = (byte)(uin >> (i * 8));
                Buffer.BlockCopy(pet, 0, packet, 8, 8);
                Buffer.BlockCopy(Encoding.ASCII.GetBytes((string)value["signHex"]), 0, packet, 16, 64);
                Buffer.BlockCopy(nickname, 0, packet, 80, nickname.Length);
                return packet;
            }
            finally
            {
                if (pet != null) Array.Clear(pet, 0, pet.Length);
                if (sign != null) Array.Clear(sign, 0, sign.Length);
                if (nickname != null) Array.Clear(nickname, 0, nickname.Length);
                value.Clear();
            }
        }
        /// <summary>
        /// The petless startup state, in its own record kind. The authoritative client's own start
        /// object takes its sign, QQ number, pet id and nickname from one object, and its login
        /// dialog decides what to do from the pet id: with a sign and a zero pet it asks the webdir
        /// for the account's start parameters and shows its own adoption window. So the value that
        /// has to travel is a sign the server issued for exactly this boot - together with a zero
        /// pet id, which is the whole difference from the entry record above. The kind is written as
        /// "QPL0" rather than reusing "QPL1" with an empty pet: the adapter that reads this record
        /// keeps its petful check untouched and accepts a zero pet only under this other kind.
        /// </summary>
        internal static byte[] PetlessBootstrap(Dictionary<string, object> value)
        {
            object raw;
            if (value.Count != 4 || !value.TryGetValue("ok", out raw) || !(raw is bool) || !(bool)raw)
                throw new IOException("SERVICE_LOGIN_INVALID");
            if (!value.TryGetValue("uin", out raw) || !(raw is int || raw is long || raw is decimal))
                throw new IOException("SERVICE_FIELD_INVALID");
            decimal number = Convert.ToDecimal(raw, CultureInfo.InvariantCulture);
            if (number < 1 || number > UInt32.MaxValue || Decimal.Truncate(number) != number)
                throw new IOException("SERVICE_FIELD_INVALID");
            if (!value.TryGetValue("generation", out raw) || !(raw is int || raw is long || raw is decimal))
                throw new IOException("SERVICE_FIELD_INVALID");
            decimal generation = Convert.ToDecimal(raw, CultureInfo.InvariantCulture);
            if (generation < 1 || generation > Int32.MaxValue || Decimal.Truncate(generation) != generation)
                throw new IOException("SERVICE_FIELD_INVALID");
            byte[] sign = null;
            try
            {
                // Exactly the shape a petless boot credential has on the wire: 64 hex characters.
                sign = Hex(value.ContainsKey("signHex") ? value["signHex"] as string : null, 32, true);
                var packet = new byte[96];
                Buffer.BlockCopy(Encoding.ASCII.GetBytes("QPL0"), 0, packet, 0, 4);
                uint uin = (uint)number;
                for (int i = 0; i < 4; i++) packet[4 + i] = (byte)(uin >> (i * 8));
                // Bytes 8..15 stay zero: the pet id of a petless boot is zero by contract, and the
                // adapter validates that instead of merely tolerating it.
                Buffer.BlockCopy(Encoding.ASCII.GetBytes((string)value["signHex"]), 0, packet, 16, 64);
                return packet;
            }
            finally
            {
                if (sign != null) Array.Clear(sign, 0, sign.Length);
                value.Clear();
            }
        }
        /// <summary>
        /// The password itself, as hex of its UTF-8 bytes, for the private control channel.
        /// The server salts and hashes it there; a digest computed here could not be verified
        /// against a salted credential, and it is the server that must decide how the stored
        /// value is checked. The bytes are cleared before this method returns.
        /// </summary>
        internal static string Password(string password)
        {
            byte[] utf8 = Encoding.UTF8.GetBytes(password);
            try
            {
                if (utf8.Length == 0 || utf8.Length > 128) throw new ArgumentException("CREDENTIAL_LENGTH");
                return BitConverter.ToString(utf8).Replace("-", "").ToLowerInvariant();
            }
            finally { Array.Clear(utf8, 0, utf8.Length); }
        }
        internal static string Quote(string value)
        {
            var result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') result.Append('\\', slashes * 2 + 1);
                else result.Append('\\', slashes);
                result.Append(c); slashes = 0;
            }
            result.Append('\\', slashes * 2);
            return result.Append('"').ToString();
        }
    }

    internal sealed class BootstrapPipe : IDisposable
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetNamedPipeClientProcessId(IntPtr handle, out uint processId);
        private readonly NamedPipeServerStream pipe;
        internal readonly string Name;
        internal BootstrapPipe()
        {
            byte[] random = new byte[24];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(random);
            Name = "QQPetLocal-" + BitConverter.ToString(random).Replace("-", "").ToLowerInvariant();
            var security = new PipeSecurity();
            security.SetAccessRuleProtection(true, false);
            var current = WindowsIdentity.GetCurrent().User;
            security.SetOwner(current);
            security.AddAccessRule(new PipeAccessRule(current, PipeAccessRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
            pipe = new NamedPipeServerStream(Name, PipeDirection.Out, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous, 0, 96, security);
        }
        private static string Await(IAsyncResult pending, Stopwatch watch, int timeoutMs, Func<bool> clientExited)
        {
            for (;;)
            {
                if (clientExited != null && clientExited()) return "BOOTSTRAP_CLIENT_EXITED";
                int remaining = timeoutMs - (int)watch.ElapsedMilliseconds;
                if (remaining <= 0) return "BOOTSTRAP_TIMEOUT";
                if (pending.AsyncWaitHandle.WaitOne(Math.Min(250, remaining))) return null;
            }
        }
        internal void Deliver(int expectedPid, byte[] packet, int timeoutMs, Func<bool> clientExited = null)
        {
            if (packet == null || packet.Length != 96 || expectedPid <= 0 || timeoutMs < 1 || timeoutMs > 180000)
                throw new ArgumentException("BOOTSTRAP_ARGUMENT_INVALID");
            var watch = Stopwatch.StartNew();
            IAsyncResult pending = pipe.BeginWaitForConnection(null, null);
            using (pending.AsyncWaitHandle)
            {
                string error = Await(pending, watch, timeoutMs, clientExited);
                if (error != null)
                {
                    pipe.Dispose();
                    try { pipe.EndWaitForConnection(pending); } catch (IOException) { } catch (ObjectDisposedException) { }
                    throw new IOException(error);
                }
                pipe.EndWaitForConnection(pending);
            }
            uint connectedPid;
            if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out connectedPid) || connectedPid != (uint)expectedPid)
                throw new IOException("BOOTSTRAP_CLIENT_REJECTED");
            pending = pipe.BeginWrite(packet, 0, packet.Length, null, null);
            using (pending.AsyncWaitHandle)
            {
                string error = Await(pending, watch, timeoutMs, clientExited);
                if (error != null)
                {
                    pipe.Dispose();
                    try { pipe.EndWrite(pending); } catch (IOException) { } catch (ObjectDisposedException) { }
                    throw new IOException(error);
                }
                pipe.EndWrite(pending);
            }
            // Disposal closes the stream after the single packet so the client can verify EOF.
        }
        public void Dispose() { pipe.Dispose(); }
    }

    /// <summary>
    /// The launcher's own lifecycle record, in one file.
    ///
    /// The record has two kinds of fact in it and they are written by two different threads: the
    /// entry's outcome (phase, error code, native exit code) is written by the background thread
    /// that owns the client, and the panel's visibility is written by the UI thread when the
    /// panel hides or comes back. A visibility change may not overwrite the outcome - a client
    /// that exited with 0 must still read as `client-exited`, and one that failed with 7 must
    /// still carry `failed` and `7` - so visibility is an extra field on the same atomically
    /// written snapshot, and the outcome fields are remembered here and re-emitted unchanged.
    ///
    /// Each call returns its commit result while holding the lock. HasFailed retains any
    /// failed commit, including a visibility update, even after a later successful write.
    /// </summary>
    internal sealed class LifecycleReport
    {
        private readonly string filename;
        private readonly object sync = new object();
        private string outcomePhase, outcomeError;
        private int? outcomeExit;
        private bool? panelVisible;
        internal bool LastWriteSucceeded { get; private set; }
        internal string LastWriteError { get; private set; }
        private bool hasFailed;
        internal bool HasFailed { get { lock (sync) { return hasFailed; } } }
        private static readonly HashSet<string> Phases = new HashSet<string>(new[] {
            "starting-service", "waiting-for-credentials", "authenticating", "authentication-rejected",
            "starting-client", "starting-client-petless", "awaiting-bootstrap", "client-running", "client-exited", "failed", "stopping", "stopped", "petless-boot-unavailable"
        });
        private static readonly HashSet<string> Errors = new HashSet<string>(new[] {
            "SERVICE_START_FAILED", "AUTH_FAILED", "AUTHENTICATION_CHANNEL_FAILED", "CLIENT_START_FAILED",
            "BOOTSTRAP_FAILED", "BOOTSTRAP_TIMEOUT", "BOOTSTRAP_CLIENT_EXITED", "CLIENT_ALREADY_RUNNING", "CLIENT_EXITED_WITH_ERROR",
            "PETLESS_BOOT_FAILED"
        });
        internal LifecycleReport(string root, string reportFile = null)
        {
            filename = reportFile ?? Path.Combine(root, "runtime", "state", "local-login", "launcher-status.json");
        }
        internal static string Snapshot(string phase, string error, int? nativeExitCode, bool? panelVisible = null)
        {
            if (!Phases.Contains(phase) || (error != null && !Errors.Contains(error))) throw new ArgumentException("LIFECYCLE_VALUE_INVALID");
            return Wire.Serializer().Serialize(new Dictionary<string, object> {
                { "phase", phase }, { "errorCode", error },
                { "panel", panelVisible.HasValue ? (panelVisible.Value ? "visible" : "hidden") : null },
                { "nativeExitCode", nativeExitCode.HasValue ? "0x" + unchecked((uint)nativeExitCode.Value).ToString("X8", CultureInfo.InvariantCulture) : null }
            });
        }
        /// <summary>Record the entry's own outcome. This is the value the coordinator分类 reads.</summary>
        internal bool Write(string phase, string error = null, int? nativeExitCode = null)
        {
            lock (sync)
            {
                outcomePhase = phase; outcomeError = error; outcomeExit = nativeExitCode;
                Persist(Snapshot(phase, error, nativeExitCode, panelVisible));
                if (LastWriteSucceeded) HasCommitted = true;
                return LastWriteSucceeded;
            }
        }
        /// <summary>
        /// Record the panel's visibility alone. The outcome fields are re-emitted exactly as the
        /// last outcome write left them, so hiding or re-showing the panel can never erase
        /// `client-exited`, `failed` or a native exit code.
        /// </summary>
        internal bool Note(bool visible)
        {
            lock (sync)
            {
                if (panelVisible == visible) return true;
                panelVisible = visible;
                if (outcomePhase == null) return true;   // no commit attempted, not a failure
                Persist(Snapshot(outcomePhase, outcomeError, outcomeExit, visible));
                return LastWriteSucceeded;
            }
        }
        /// <summary>
        /// Commit one snapshot, with a boundary that can be stated in one sentence: either the
        /// previous record is still exactly what it was, or the new record is completely in
        /// place, and nothing in between survives a failure.
        ///
        /// The temporary file is written first and completely, so no reader ever sees a partial
        /// record. The commit itself is an atomic replace, which is the only operation on this
        /// platform that swaps a file's contents without a moment where the name has no content:
        ///
        ///   * no target yet - the temporary is moved into place; if that fails there is still no
        ///     record, and the caller is told so;
        ///   * target exists - `File.Replace` swaps them, and `File.Replace` also needs the backup
        ///     argument to be a real path on some filesystems, so the previous record is passed as
        ///     the backup file and removed afterwards;
        ///   * the replace is refused - the write **fails**. It does not fall back to deleting the
        ///     target and moving the temporary over it: that window, however short, is exactly the
        ///     "atomic" promise this file may not make. The previous record stays valid, the
        ///     temporary is removed so no residue accumulates, and the caller reads the failure.
        ///
        /// A failure is never hidden: <see cref="LastWriteSucceeded"/> is false, the previous bytes
        /// are still on disk, and a caller that needs the state persisted has to say so. A later
        /// successful write does not erase the record of an earlier failure within this attempt -
        /// that is accumulated here under the same lock for both Write and Note.
        /// </summary>
        private void Persist(string data)
        {
            LastWriteSucceeded = false; LastWriteError = null;
            string temporary = filename + ".tmp";
            string previous = filename + ".previous";
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(filename));
                File.WriteAllText(temporary, data + "\n", new UTF8Encoding(false));
                if (!File.Exists(filename))
                {
                    File.Move(temporary, filename);
                }
                else
                {
                    if (File.Exists(previous)) File.Delete(previous);
                    File.Replace(temporary, filename, previous);
                    if (File.Exists(previous)) File.Delete(previous);
                }
                LastWriteSucceeded = true;
            }
            catch (IOException error) { LastWriteError = error.GetType().Name; }
            catch (UnauthorizedAccessException error) { LastWriteError = error.GetType().Name; }
            finally
            {
                if (!LastWriteSucceeded) hasFailed = true;
                // Whatever happened, a half-written temporary is not left behind: it is either
                // committed (gone by the move), or discarded here.
                try { if (File.Exists(temporary)) File.Delete(temporary); } catch (IOException) { }
                catch (UnauthorizedAccessException) { }
                try { if (File.Exists(previous)) File.Delete(previous); } catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
        /// <summary>Whether the record has ever been committed in this process.</summary>
        internal bool HasCommitted { get; private set; }
        /// <summary>
        /// The first commit is the one the launcher cannot proceed without: before it there is no
        /// record at all, so a failure means the session would run with no observable state.
        /// </summary>
        internal bool TryWrite(string phase, string error = null, int? nativeExitCode = null)
        {
            return Write(phase, error, nativeExitCode);
        }
        /// <summary>Read the record back. The acceptance check uses this instead of trusting a write.</summary>
        internal static string Read(string filename)
        {
            return File.ReadAllText(filename, new UTF8Encoding(false));
        }
        internal static string Record(string root, string reportFile = null)
        {
            return reportFile ?? Path.Combine(root, "runtime", "state", "local-login", "launcher-status.json");
        }
    }

    internal sealed class Options
    {
        internal string Node = Path.Combine(Environment.GetEnvironmentVariable("ProgramW6432") ?? Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        internal readonly List<string> ServerArgs = new List<string>();
        internal readonly string Root;
        internal string LifecycleReportFile;
        internal string ServicePipe;
        internal string RemoteConfig;
        internal string ClientOverride;
        internal Action PrepareComplete;
        internal bool CompactPackage;
        internal string StateDirectory;
        internal string Client { get { return ClientOverride ?? Path.Combine(Root, "runtime", "client", "txsso-12529-login-acceptance-20260906", "QQPenguin.exe"); } }
        internal string Server { get { return Path.Combine(Root, "tools", "start-local-login-server.mjs"); } }
        internal Options(string root, string[] args)
        {
            bool explicitPipe = false;
            Root = Path.GetFullPath(root);
            if (File.Exists(Path.Combine(Root,"QQPetAgent","package-state.json"))) {
                var complete = new CompleteLaunchConfiguration(Root);
                CompactPackage = complete.CompactPackage;
                StateDirectory = complete.StateDirectory;
                LifecycleReportFile = Path.Combine(StateDirectory,"launcher-status.json");
            }
            if (Path.GetFileNameWithoutExtension(Application.ExecutablePath) == "QQPetClient") {
                ServicePipe = ResidentChannel.Name(Root);
                LifecycleReportFile = Path.Combine(Root, "runtime", "state", "qqpet12-acceptance", "desktop-local", "session", "launcher-status.json");
            }
            for (int i = 0; i < args.Length; i++)
            {
                if (++i >= args.Length) throw new ArgumentException("ARGUMENT_INVALID");
                if (args[i - 1] == "--node") Node = args[i];
                else if (args[i - 1] == "--service-pipe") {
                    if (args[i] != ResidentChannel.Name(Root)) throw new ArgumentException("SERVICE_PIPE_INVALID");
                    ServicePipe = args[i];
                    explicitPipe = true;
                }
                else if (args[i - 1] == "--remote-config") {
                    if (RemoteConfig != null) throw new ArgumentException("REMOTE_CONFIG_DUPLICATE");
                    RemoteConfig = Path.GetFullPath(args[i]);
                }
                else if (args[i - 1] == "--lifecycle-report") {
                    string file = Path.GetFullPath(args[i]);
                    string allowed = Path.Combine(Root, "runtime", "state", "qqpet12-acceptance") + Path.DirectorySeparatorChar;
                    if (!file.StartsWith(allowed, StringComparison.OrdinalIgnoreCase) || Path.GetFileName(file) != "launcher-status.json") throw new ArgumentException("REPORT_OUTSIDE_ACCEPTANCE");
                    LifecycleReportFile = file;
                }
                else if (args[i - 1] == "--client") {
                    if (ClientOverride != null) throw new ArgumentException("CLIENT_DUPLICATE");
                    string file = Path.GetFullPath(args[i]);
                    string allowed = Path.Combine(Root, "runtime", "client") + Path.DirectorySeparatorChar;
                    bool compactClient = CompactPackage && String.Equals(file, Path.Combine(Root,"QQPenguin","QQPenguin.exe"),StringComparison.OrdinalIgnoreCase);
                    if ((!file.StartsWith(allowed, StringComparison.OrdinalIgnoreCase) && !compactClient) || Path.GetFileName(file) != "QQPenguin.exe") throw new ArgumentException("CLIENT_OUTSIDE_RUNTIME");
                    for (string check = file; check != Root; check = Path.GetDirectoryName(check))
                        if (File.Exists(check) || Directory.Exists(check))
                            if ((File.GetAttributes(check) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("CLIENT_REPARSE_POINT");
                    ClientOverride = file;
                }
                else if (args[i - 1] == "--server-arg") ServerArgs.Add(args[i]);
                else throw new ArgumentException("ARGUMENT_INVALID");
            }
            if (RemoteConfig != null) {
                if (explicitPipe || ServerArgs.Count != 0) throw new ArgumentException("REMOTE_LOCAL_ARGUMENT_CONFLICT");
                ServicePipe = null;
            }
            if (RemoteConfig == null && ServicePipe == null && (!Path.IsPathRooted(Node) || !File.Exists(Node))) throw new ArgumentException("NODE_MISSING");
            if (ServicePipe != null && ServerArgs.Count != 0) throw new ArgumentException("EXTERNAL_SERVICE_HAS_NO_SERVER_ARGUMENTS");
            var values = new HashSet<string>(new[] { "--deployment-endpoints", "--legacy-community-home-profile", "--database", "--webdir-profile", "--webdir-zone-template", "--post-entry-profile", "--online-vitals-profile", "--pet-business-profile", "--membership-profile", "--care-economy-profile", "--play-menu-profile", "--wardrobe-profile", "--friend-policy", "--unknown-command-policy", "--game-port", "--webdir-port", "--account-web-port", "--report", "--market-client-root", "--account-backups-root" });
            // The HTML market selection reaches the server through these: the main switch and
            // the desktop-entry switch are bare flags, the read-only page root is a value.
            var switches = new HashSet<string>(new[] { "--enable-legacy-community-home-compatibility", "--enable-legacy-community-entry-compatibility", "--enable-desktop-tasks", "--enable-html-market-compatibility", "--enable-desktop-game-entry", "--enable-native-avatar-preview" });
            var seen = new HashSet<string>();
            for (int i = 0; i < ServerArgs.Count; i++)
            {
                string key = ServerArgs[i];
                if (!seen.Add(key)) throw new ArgumentException("SERVER_ARGUMENT_DUPLICATE");
                if (switches.Contains(key)) continue;
                if (!values.Contains(key) || ++i >= ServerArgs.Count) throw new ArgumentException("SERVER_ARGUMENT_INVALID");
                string value = ServerArgs[i];
                if (value.Length == 0 || value.Length > 1024 || value.StartsWith("--") || value.IndexOfAny(new[] { '\r', '\n', '\0' }) >= 0)
                    throw new ArgumentException("SERVER_ARGUMENT_INVALID");
                if (key == "--friend-policy" && value != "all-server-pets" && value != "community-friends")
                    throw new ArgumentException("FRIEND_POLICY_INVALID");
                if (key == "--report")
                {
                    string report = Path.GetFullPath(Path.IsPathRooted(value) ? value : Path.Combine(Root, value));
                    string runtime = Path.GetFullPath(Path.Combine(Root, "runtime")) + Path.DirectorySeparatorChar;
                    if (!report.StartsWith(runtime, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("REPORT_OUTSIDE_RUNTIME");
                    ServerArgs[i] = report;
                }
            }
        }
    }

    /// <summary>
    /// The page addresses the local service reported on its readiness line. Each one is the
    /// exact loopback URL the service bound, so the panel never has to guess a port.
    /// </summary>
    internal sealed class ServiceUrls
    {
        internal readonly string Register, Reset, Adopt;
        internal ServiceUrls(string register, string reset, string adopt) { Register = register; Reset = reset; Adopt = adopt; }
    }

    internal static class ResidentChannel
    {
        internal static string Name(string root) {
            string identity = WindowsIdentity.GetCurrent().User.Value + "|" + Path.GetFullPath(root).TrimEnd('\\').ToUpperInvariant();
            using (var hash = SHA256.Create()) return "QQPetResident-" + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(identity))).Replace("-", "").Substring(0, 32);
        }
    }

    internal sealed class Service : IDisposable
    {
        private readonly Process process;
        private readonly NamedPipeClientStream connection;
        private readonly RemoteLoginTransport remote;
        private readonly StreamReader input;
        private readonly StreamWriter output;
        private bool disposed;
        private static ProcessStartInfo StartInfo(Options options)
        {
            var command = new StringBuilder(Wire.Quote(options.Server)).Append(" --stdio-control");
            foreach (string arg in options.ServerArgs) command.Append(' ').Append(Wire.Quote(arg));
            var start = new ProcessStartInfo(options.Node, command.ToString()) {
                WorkingDirectory = options.Root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false, true), StandardErrorEncoding = Encoding.UTF8
            };
            start.EnvironmentVariables.Remove("QQPET_LOCAL_BOOTSTRAP_PIPE");
            start.EnvironmentVariables.Remove("QQPET_LOCAL_BOOTSTRAP_OWNER");
            return start;
        }
        internal Service(Options options)
        {
            if (options.RemoteConfig != null) { remote = new RemoteLoginTransport(options.RemoteConfig); return; }
            if (options.ServicePipe != null) {
                connection = new NamedPipeClientStream(".", options.ServicePipe, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
                try { connection.Connect(3000); }
                catch (Exception error) { connection.Dispose(); throw new IOException("START_RESIDENT_SERVER_FIRST", error); }
                input = new StreamReader(connection, new UTF8Encoding(false, true), false, 1024, true);
                output = new StreamWriter(connection, new UTF8Encoding(false), 1024, true) { AutoFlush = true };
            } else {
                process = Process.Start(StartInfo(options));
                input = process.StandardOutput; output = process.StandardInput;
                DiscardErrors(process);
            }
        }
        internal Service(ProcessStartInfo start)
        {
            process = Process.Start(start);
            input = process.StandardOutput; output = process.StandardInput;
            DiscardErrors(process);
        }
        private static void DiscardErrors(Process process) {
            // Deliberately discard diagnostics, never echo server messages or authentication material.
            Task.Run(() => { try { var buffer = new char[512]; while (process.StandardError.Read(buffer, 0, buffer.Length) > 0) { Array.Clear(buffer, 0, buffer.Length); } } catch { } });
        }
        internal Dictionary<string, object> Receive()
        {
            var task = Task.Run(() => Wire.Read(input));
            if (!task.Wait(30000)) throw new IOException("SERVICE_TIMEOUT");
            return task.Result;
        }
        internal ServiceUrls Ready()
        {
            var value = remote == null ? Receive() : remote.Exchange(new Dictionary<string, object> { { "op", "ready" } }); object ready;
            if (!value.TryGetValue("ready", out ready) || !(ready is bool) || !(bool)ready)
                throw new IOException("SERVICE_NOT_READY");
            // The readiness line is either the bare token or the token with the three page
            // addresses; anything else is a peer this launcher does not understand.
            if (value.Count == 1) { value.Clear(); return null; }
            ServiceUrls urls = Urls(value);
            if (value.Count != 4) throw new IOException("SERVICE_NOT_READY");
            value.Clear();
            return urls;
        }
        private static ServiceUrls Urls(Dictionary<string, object> value)
        {
            var fields = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (string key in new[] { "registerUrl", "resetUrl", "adoptUrl" })
            {
                object raw;
                string url = value.TryGetValue(key, out raw) ? raw as string : null;
                if (!AllowedLocalUrl(url, key.Substring(0, key.Length - 3)))
                    throw new IOException("SERVICE_NOT_READY");
                fields[key] = url;
            }
            return new ServiceUrls(fields["registerUrl"], fields["resetUrl"], fields["adoptUrl"]);
        }
        // A page address must parse as an absolute http URL on the exact loopback host with an
        // explicit port, no user info, no query or fragment, and exactly the path the key names.
        // Prefix checks would accept disguises: a userinfo segment, a decimal or hex form of the
        // loopback address, another host after an @, a default port, or a path that merely starts
        // with the expected one.
        private static bool AllowedLocalUrl(string url, string page)
        {
            if (string.IsNullOrEmpty(url) || url.Length > 128) return false;
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri)) return false;
            if (uri.Scheme != Uri.UriSchemeHttp) return false;
            if (uri.HostNameType != UriHostNameType.IPv4 || uri.Host != "127.0.0.1") return false;
            if (uri.UserInfo.Length != 0) return false;
            if (uri.IsDefaultPort || uri.Port < 1 || uri.Port > 65535) return false;
            if (uri.Query.Length != 0 || uri.Fragment.Length != 0) return false;
            return uri.AbsolutePath == "/" + page;
        }
        internal enum LoginOutcome { Rejected, Authenticated, Petless }

        private Dictionary<string, object> Exchange(Dictionary<string, object> request)
        {
            try {
                if (remote != null) return remote.Exchange(request);
                output.WriteLine(Wire.Serializer().Serialize(request)); output.Flush();
                return Receive();
            } finally { request.Clear(); }
        }

        internal LoginOutcome Authenticate(string account, string password, out byte[] packet, out string adoptToken)
        {
            packet = null; adoptToken = null;
            var request = new Dictionary<string, object> { { "op", "login" }, { "account", account }, { "passwordHex", password } };
            var response = Exchange(request); object ok;
            if (response.TryGetValue("ok", out ok) && ok is bool && !(bool)ok)
            {
                if (response.Count == 2 && response.ContainsKey("error") && (response["error"] as string) == "AUTH_FAILED") { response.Clear(); return LoginOutcome.Rejected; }
                response.Clear(); throw new IOException("SERVICE_LOGIN_FAILED");
            }
            // A registered account that has not adopted yet authenticates as itself: it is not a
            // failed login and it must not be given a pet here. The adoption handle rides along,
            // so the adoption window can act for exactly this account without a second login.
            object petless;
            if (response.TryGetValue("petless", out petless) && petless is bool && (bool)petless)
            {
                object raw;
                adoptToken = response.TryGetValue("adoptToken", out raw) ? raw as string : null;
                if (adoptToken == null || adoptToken.Length != 32 || !IsHex32(adoptToken)) adoptToken = null;
                response.Clear();
                return LoginOutcome.Petless;
            }
            packet = Wire.Bootstrap(response);
            return LoginOutcome.Authenticated;
        }
        private static bool IsHex32(string value)
        {
            foreach (char c in value) if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f')) return false;
            return true;
        }
        // The adoption step of the first-entry flow: the Flash window's gender choice, bound to
        // the handle the petless login issued. The success reply is the exact entry shape a
        // login success carries, so the caller continues into the client unchanged.
        internal bool Adopt(string adoptToken, string gender, out byte[] packet)
        {
            packet = null;
            var request = new Dictionary<string, object> { { "op", "adopt" }, { "adoptToken", adoptToken }, { "gender", gender } };
            var response = Exchange(request); object ok;
            if (response.TryGetValue("ok", out ok) && ok is bool && (bool)ok)
            {
                packet = Wire.Bootstrap(response);
                return true;
            }
            response.Clear();
            return false;
        }
        // The petless startup state of the same petless login: the server's own boot credential for
        // exactly this account, in its own record kind. This is what the launcher hands the client
        // when the account has no pet, so the client runs its own start-parameter branch, decides
        // the account has no pet, and opens its own adoption window. Nothing is adopted here.
        internal bool PetlessBoot(string adoptToken, out byte[] packet)
        {
            packet = null;
            var request = new Dictionary<string, object> { { "op", "petless-boot" }, { "adoptToken", adoptToken } };
            var response = Exchange(request); object ok;
            if (response.TryGetValue("ok", out ok) && ok is bool && (bool)ok)
            {
                try { packet = Wire.PetlessBootstrap(response); return true; }
                catch { return false; }
            }
            response.Clear();
            return false;
        }
        public void Dispose()
        {
            lock (this) { if (disposed) return; disposed = true; }
            if (remote != null) return;
            if (connection != null) { try { output.Dispose(); } finally { connection.Dispose(); input.Dispose(); } return; }
            try
            {
                if (!process.HasExited)
                {
                    process.StandardInput.WriteLine("{\"op\":\"shutdown\"}"); process.StandardInput.Flush();
                    if (!process.WaitForExit(5000)) { process.Kill(); process.WaitForExit(5000); }
                }
            }
            catch { try { if (!process.HasExited) process.Kill(); } catch { } }
            finally { process.Dispose(); }
        }
    }

    internal static class Program
    {
        [STAThread]
        // The exit codes this launcher reports. 0 is a session whose final state was committed;
        // 3 is a session whose state could not be written, which the coordinator has to treat as a
        // failure even when the last bytes still on disk look like an older success. The process
        // result is the one channel that survives a report the filesystem refuses to update.
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                string root;
                try { root = CompleteLaunchConfiguration.FindRoot(AppDomain.CurrentDomain.BaseDirectory); }
                catch (IOException) { if (args.Length == 0) throw; root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", "..")); }
                CompleteLaunchConfiguration complete = null;
                if (args.Length == 0) { complete = new CompleteLaunchConfiguration(root); args = complete.Arguments(); }
                var options = new Options(root, args);
                if (complete != null) options.PrepareComplete = complete.Prepare;
                if ((options.RemoteConfig == null && options.ServicePipe == null && !File.Exists(options.Server)) || !File.Exists(options.Client) || !File.Exists(Path.Combine(Path.GetDirectoryName(options.Client), "LocalLoginBridge.dll")))
                    throw new IOException("RUNTIME_MISSING");
                using (var packageLock = options.CompactPackage ? new ClientPackageLock(options.StateDirectory) : null) {
                    var form = new LoginForm(options, new UIResources(options.Client));
                    Application.Run(form);
                    return form.ReportFailed ? 3 : 0;
                }
            }
            catch { MessageBox.Show("启动文件不完整或已被修改，请检查完整客户端目录。", "QQ宠物", MessageBoxButtons.OK, MessageBoxIcon.Error); return 2; }
        }
    }
    internal sealed class ClientPackageLock : IDisposable {
        private readonly FileStream stream;
        private readonly string filename;
        internal ClientPackageLock(string directory) {
            Directory.CreateDirectory(directory); filename=Path.Combine(directory,"runtime.pid");
            if(File.Exists(filename)&&(File.GetAttributes(filename)&FileAttributes.ReparsePoint)!=0)throw new IOException("CLIENT_LOCK_INVALID");
            stream=new FileStream(filename,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.Read);
            try {
                byte[] data=Encoding.ASCII.GetBytes("{\"pid\":"+Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture)+"}\n");
                stream.SetLength(0);stream.Write(data,0,data.Length);stream.Flush(true);
            } catch { stream.Dispose();try{File.Delete(filename);}catch(IOException){}catch(UnauthorizedAccessException){}throw; }
        }
        public void Dispose() { stream.Dispose();try{File.Delete(filename);}catch(IOException){}catch(UnauthorizedAccessException){} }
    }
}
