using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace QQPet.LocalLogin
{
    // Explicit, per-connection trust. No certificate-store installation, global TLS
    // callback, proxy setting or browser cookie is involved.
    internal sealed class RemoteLoginTransport
    {
        private readonly Uri origin;
        private readonly string pin;
        private string certificateError;
        internal RemoteLoginTransport(string filename)
        {
            if (new FileInfo(filename).Length > 2048) throw new IOException("REMOTE_CONFIG_INVALID");
            var value = Wire.Serializer().DeserializeObject(File.ReadAllText(filename, new UTF8Encoding(false, true))) as Dictionary<string, object>;
            if (value == null || value.Count != 3 || !value.ContainsKey("schemaVersion") || !(value["schemaVersion"] is int) || (int)value["schemaVersion"] != 1
                || !value.ContainsKey("loginOrigin") || !value.ContainsKey("certificateSha256")) throw new IOException("REMOTE_CONFIG_INVALID");
            string address = value["loginOrigin"] as string;
            pin = value["certificateSha256"] as string;
            if (address == null || !Uri.TryCreate(address, UriKind.Absolute, out origin) || origin.Scheme != "https"
                || origin.HostNameType != UriHostNameType.IPv4 || origin.Port < 1 || origin.Port > 65535
                || address != "https://" + origin.Host + ":" + origin.Port.ToString(System.Globalization.CultureInfo.InvariantCulture)
                || pin == null || pin.Length != 64) throw new IOException("REMOTE_CONFIG_INVALID");
            foreach (char c in pin) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) throw new IOException("REMOTE_CONFIG_INVALID");
            IPAddress ip;
            if (!IPAddress.TryParse(origin.Host, out ip) || ip.ToString() != origin.Host) throw new IOException("REMOTE_CONFIG_INVALID");
            byte[] bytes = ip.GetAddressBytes();
            if (bytes[0] == 0 || bytes[0] >= 224 || (bytes[0] == 169 && bytes[1] == 254)) throw new IOException("REMOTE_CONFIG_INVALID");
        }
        private bool ValidateCertificate(object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors errors)
        {
            if (certificate == null) return false;
            using (var cert = new X509Certificate2(certificate))
            using (var hash = SHA256.Create())
            {
                string actual = BitConverter.ToString(hash.ComputeHash(cert.RawData)).Replace("-", "").ToLowerInvariant();
                int difference = 0; for (int i = 0; i < pin.Length; i++) difference |= actual[i] ^ pin[i];
                bool current=DateTime.UtcNow >= cert.NotBefore.ToUniversalTime() && DateTime.UtcNow <= cert.NotAfter.ToUniversalTime();
                if(difference!=0)certificateError="REMOTE_CERTIFICATE_MISMATCH";
                else if(!current)certificateError="REMOTE_CERTIFICATE_EXPIRED";
                return difference == 0 && current;
            }
        }
        private static string Line(Stream stream)
        {
            var value = new StringBuilder();
            for (int i = 0; i < 1024; i++) {
                int b = stream.ReadByte();
                if (b < 0) throw new IOException("REMOTE_REPLY_INVALID");
                if (b == 13) { if (stream.ReadByte() != 10) throw new IOException("REMOTE_REPLY_INVALID"); return value.ToString(); }
                if (b < 32 || b > 126) throw new IOException("REMOTE_REPLY_INVALID");
                value.Append((char)b);
            }
            throw new IOException("REMOTE_REPLY_INVALID");
        }
        internal Dictionary<string, object> Exchange(Dictionary<string, object> request)
        {
            byte[] body = Encoding.UTF8.GetBytes(Wire.Serializer().Serialize(request));
            try {
                if (body.Length > 4096) throw new IOException("REMOTE_REQUEST_INVALID");
                using (var client = new TcpClient(AddressFamily.InterNetwork)) {
                    var connected = client.ConnectAsync(origin.Host, origin.Port);
                    if (!connected.Wait(5000)) throw new IOException("REMOTE_TIMEOUT");
                    using (var stream = new SslStream(client.GetStream(), false, ValidateCertificate)) {
                        stream.ReadTimeout = 10000; stream.WriteTimeout = 10000;
                        try { stream.AuthenticateAsClient(origin.Host, null, SslProtocols.Tls12, false); }
                        catch(AuthenticationException){throw new IOException(certificateError??"REMOTE_TLS_FAILED");}
                        byte[] header = Encoding.ASCII.GetBytes("POST /v1/login HTTP/1.1\r\nHost: " + origin.Authority
                            + "\r\nContent-Type: application/json\r\nContent-Length: " + body.Length.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\r\nConnection: close\r\n\r\n");
                        stream.Write(header, 0, header.Length); stream.Write(body, 0, body.Length); stream.Flush();
                        if (Line(stream) != "HTTP/1.1 200 OK") throw new IOException("REMOTE_REQUEST_FAILED");
                        int length = -1, total = 0; bool json = false;
                        for (int count = 0; ; count++) {
                            string line = Line(stream); total += line.Length;
                            if (count > 32 || total > 8192) throw new IOException("REMOTE_REPLY_INVALID");
                            if (line.Length == 0) break;
                            int at = line.IndexOf(':'); if (at < 1) throw new IOException("REMOTE_REPLY_INVALID");
                            string key = line.Substring(0, at).ToLowerInvariant(), value = line.Substring(at + 1).Trim();
                            if (key == "transfer-encoding") throw new IOException("REMOTE_REPLY_INVALID");
                            if (key == "content-length") {
                                if (length != -1 || !int.TryParse(value, out length) || length < 1 || length > 4096) throw new IOException("REMOTE_REPLY_INVALID");
                            }
                            if (key == "content-type") json = value == "application/json; charset=utf-8";
                        }
                        if (length < 1 || !json) throw new IOException("REMOTE_REPLY_INVALID");
                        byte[] reply = new byte[length];
                        try {
                            for (int offset = 0; offset < length;) {
                                int n = stream.Read(reply, offset, length - offset); if (n == 0) throw new IOException("REMOTE_REPLY_INVALID"); offset += n;
                            }
                            var value = Wire.Serializer().DeserializeObject(new UTF8Encoding(false, true).GetString(reply)) as Dictionary<string, object>;
                            if (value == null) throw new IOException("REMOTE_REPLY_INVALID"); return value;
                        } finally { Array.Clear(reply, 0, reply.Length); }
                    }
                }
            } finally { Array.Clear(body, 0, body.Length); }
        }
    }
}
