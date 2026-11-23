using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Xml;

namespace QQPet.LocalLogin
{
    internal sealed class CompleteLaunchConfiguration
    {
        private readonly string root;
        private readonly Dictionary<string, object> manifest;
        private readonly bool package;
        private readonly string stateFile;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024, RecursionLimit = 64 };
        internal static string FindRoot(string start)
        {
            string initial = Path.GetFullPath(start);
            if (initial.Length > Path.GetPathRoot(initial).Length) initial = initial.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            for (string p = initial; p != null; p = Path.GetDirectoryName(p)) {
                // In the compact package the inventory lives beside the agent,
                // and its paths are relative to the parent client directory.
                if (String.Equals(Path.GetFileName(p),"QQPetAgent",StringComparison.OrdinalIgnoreCase)
                    && File.Exists(Path.Combine(p,"package-state.json"))) return Path.GetDirectoryName(p);
                if (File.Exists(Path.Combine(p, "QQPetAgent", "package-state.json")) || File.Exists(Path.Combine(p, "package-state.json")) || File.Exists(Path.Combine(p, "server", "config", "development-baseline.json"))) return p;
            }
            throw new IOException("COMPLETE_BASELINE_MISSING");
        }
        private string Safe(string relative)
        {
            if (String.IsNullOrEmpty(relative) || Path.IsPathRooted(relative) || relative.IndexOfAny(new[] { ':', '\\', '\0' }) >= 0) throw new IOException("COMPLETE_PATH_INVALID");
            string current = root;
            foreach (string part in relative.Split('/')) {
                if (part == "" || part == "." || part == "..") throw new IOException("COMPLETE_PATH_INVALID");
                current = Path.Combine(current, part);
                if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("COMPLETE_LINK_REFUSED");
            }
            return current;
        }
        private static string Hash(string file)
        { using (var digest = SHA256.Create()) using (var stream = File.OpenRead(file)) return BitConverter.ToString(digest.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
        private Dictionary<string, object> Read(string name) { return json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Safe(name), Encoding.UTF8)); }
        internal CompleteLaunchConfiguration(string root)
        {
            this.root = Path.GetFullPath(root);
            bool compact = File.Exists(Safe("QQPetAgent/package-state.json"));
            stateFile = compact ? "QQPetAgent/package-state.json" : "package-state.json";
            if (compact && File.Exists(Safe("package-state.json"))) throw new IOException("COMPLETE_PACKAGE_AMBIGUOUS");
            if (File.Exists(Safe(stateFile))) {
                manifest = Read(stateFile);
                if ((string)manifest["kind"] != "qqpet-complete-package" || Convert.ToInt32(manifest["schemaVersion"]) != 1 || (string)manifest["part"] != "client" || (string)manifest["status"] != "ready"
                    || (string)manifest["clientRoot"] != (compact ? "QQPenguin" : "runtime/client/legacy-community-home-20261008")
                    || (string)manifest["helperRoot"] != (compact ? "QQPetAgent" : "runtime/tools/legacy-community-home-20261008")) throw new IOException("COMPLETE_PACKAGE_INVALID");
                if (compact && (!manifest.ContainsKey("launcherFile") || (string)manifest["launcherFile"] != "QQPetAgent/QQPetAgent.exe" || !manifest.ContainsKey("stateRoot") || (string)manifest["stateRoot"] != "QQPetAgent/State")) throw new IOException("COMPLETE_PACKAGE_INVALID");
                package = true; return;
            }
            var registry = Read("server/config/development-baseline.json");
            string file = (string)registry["manifest"];
            if ((string)registry["kind"] != "qqpet-development-baseline" || !Equals(registry["isolatedTestsRequireCompleteBaseline"], true) || Hash(Safe(file)) != (string)registry["manifestSha256"]) throw new IOException("COMPLETE_BASELINE_CHANGED");
            manifest = Read(file);
            if ((string)manifest["kind"] != "qqpet-complete-feature-baseline" || (string)manifest["id"] != (string)registry["id"] || !Equals(manifest["accountDataIncluded"], false)) throw new IOException("COMPLETE_BASELINE_INVALID");
        }
        internal bool CompactPackage { get { return package && stateFile == "QQPetAgent/package-state.json"; } }
        internal string ClientExecutable { get { return Safe((string)manifest["clientRoot"] + "/QQPenguin.exe"); } }
        internal string StateDirectory { get { return CompactPackage ? Safe("QQPetAgent/State") : null; } }
        internal string[] Arguments()
        {
            var result = new List<string> { "--client", Safe((string)manifest["clientRoot"] + "/QQPenguin.exe") };
            if (package) { result.Add("--remote-config"); result.Add(Safe((string)manifest["helperRoot"] + "/client-login.json")); return result.ToArray(); }
            foreach (object value in json.Deserialize<object[]>(File.ReadAllText(Safe((string)manifest["configRoot"] + "/server-arguments.json"), Encoding.UTF8))) { result.Add("--server-arg"); result.Add((string)value); }
            return result.ToArray();
        }
        internal string LauncherExecutable()
        {
            string name=CompactPackage ? "QQPetAgent/QQPetAgent.exe" : (string)manifest["helperRoot"]+"/LocalLoginLauncher.exe", file=Safe(name), expected=null;
            foreach(object raw in (System.Collections.IEnumerable)manifest["files"]) {
                var row=(Dictionary<string,object>)raw;if((string)row["path"]==name)expected=(string)row["sha256"];
            }
            if(expected==null||Hash(file)!=expected)throw new IOException("COMPLETE_LAUNCHER_CHANGED");
            return file;
        }
        internal void Prepare()
        {
            if (File.Exists(Safe("runtime/ip-change/pending.json")) || File.Exists(Safe("address-update.pending"))) throw new IOException("ADDRESS_TRANSACTION_PENDING");
            string clientPrefix = (string)manifest["clientRoot"] + "/";
            foreach (object raw in (System.Collections.IEnumerable)manifest["files"]) {
                var row = (Dictionary<string, object>)raw; string name = (string)row["path"];
                if (name.StartsWith("runtime/state/", StringComparison.Ordinal) || name.StartsWith("QQPetAgent/State/", StringComparison.Ordinal)) throw new IOException("PRIVATE_FILE_REFUSED");
                if (name.StartsWith(clientPrefix, StringComparison.Ordinal)) {
                    string top = name.Substring(clientPrefix.Length).Split('/')[0];
                    bool numeric = top.Length > 0; foreach (char c in top) numeric = numeric && c >= '0' && c <= '9';
                    if (numeric) throw new IOException("PRIVATE_FILE_REFUSED");
                }
                if (name == "server/config/runtime-log.json") continue;
                string file = Safe(name);
                if (new FileInfo(file).Length != Convert.ToInt64(row["size"], CultureInfo.InvariantCulture) || Hash(file) != (string)row["sha256"]) throw new IOException("COMPLETE_FIXED_FILE_CHANGED");
            }
            InitializeInstalledState((string)manifest["clientRoot"]);
        }
        private void InitializeInstalledState(string client)
        {
            var catalogue = Read(client + "/config/installed-startup.json");
            if ((string)catalogue["kind"] != "qqpet-installed-startup" || Convert.ToInt32(catalogue["schemaVersion"]) != 1) throw new IOException("STARTUP_CATALOGUE_INVALID");
            string version = Convert.ToString(catalogue["rootVersion"], CultureInfo.InvariantCulture);
            var document = new XmlDocument { XmlResolver = null };
            using (var reader = XmlReader.Create(Safe(client + "/Plugin" + version + ".xml"), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null })) document.Load(reader);
            if (document.DocumentElement.Name != "PluginXML" || document.DocumentElement.GetAttribute("Version") != version) throw new IOException("STARTUP_PLUGIN_MISMATCH");
            var resources = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (XmlElement item in document.SelectNodes("//Item[@FILE and @Version]")) resources[item.GetAttribute("FILE")] = item.GetAttribute("Version");
            var contents = new StringBuilder();
            foreach (object raw in (System.Collections.IEnumerable)catalogue["resources"]) {
                var row = (Dictionary<string, object>)raw; string name = (string)row["path"], expected;
                if (!resources.TryGetValue(name, out expected)) continue; // fixed root-layout records the approved removed registrations
                string actual = Convert.ToString(row["version"], CultureInfo.InvariantCulture);
                if (actual != expected) throw new IOException("STARTUP_PLUGIN_MISMATCH");
                contents.Append("[" + name + "]\r\nVersion=" + actual + "\r\n\r\n"); resources.Remove(name);
            }
            if (resources.Count != 0) throw new IOException("STARTUP_PLUGIN_MISMATCH");
            CreateOnly(client + "/pluginversion.ini", "[localpluginversion]\r\nversion=" + version + "\r\n");
            CreateOnly(client + "/LocalVersion.ini", contents.ToString());
        }
        private void CreateOnly(string name, string contents)
        {
            string file = Safe(name); if (File.Exists(file)) return;
            string temporary = file + ".create-" + Guid.NewGuid().ToString("N");
            try { using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { byte[] bytes = Encoding.ASCII.GetBytes(contents); stream.Write(bytes, 0, bytes.Length); stream.Flush(true); } try { File.Move(temporary, file); } catch (IOException) { if (!File.Exists(file)) throw; } }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
    }
}
