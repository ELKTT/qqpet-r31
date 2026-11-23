// The babyinfo HTTP contract PetInfo.swf speaks (res/Plugins/QuickFeed/PetInfo.swf, static
// facts in analysis/notes/petinfo-rename-chain-20260925.md and the review-35 export): the
// panel reads its identity from the host (getSelfUin/getPetSign/getSelfPetID) and sends
//   /fcgi-bin/babyinfo?cmd=10&petid=…&petsign=…&localtime=…            (pet info read)
//   /fcgi-bin/babyinfo?cmd=11&petid=…&petsign=…&pet_name=…&localtime=…  (pet rename)
//   /fcgi-bin/babyinfo?cmd=12&petid=…&petsign=…&master_name=…&localtime=… (master-name rename)
// The reply is an XML document whose <result> child turns to 0 on success (review-35 static
// closure); a non-zero result makes the panel restore the old name and show <msg>.
const uint64 = (s) => typeof s === "string" && /^(0|[1-9][0-9]*)$/.test(s) && BigInt(s) > 0n && BigInt(s) <= 0xfffffffffffffffn;
const cacheBuster = (s) => typeof s === "string" && s.length <= 32 && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(s);
const hexTicket = (s) => typeof s === "string" && /^[A-Fa-f0-9]{64}$/.test(s);

export function parsePetInfoHttpRequest(authority, target) {
  if (authority !== "web.pet.qq.com" || typeof target !== "string"
      || target.length > 4096 || !target.startsWith("/fcgi-bin/babyinfo?")) {
    throw new TypeError("PETINFO_ROUTE_INVALID");
  }
  const url = new URL(target, "http://" + authority), q = url.searchParams;
  if ([...q.keys()].some((k) => q.getAll(k).length !== 1)) throw new TypeError("PETINFO_QUERY_DUPLICATE");
  const cmd = q.get("cmd");
  if (!["10", "11", "12"].includes(cmd)) throw new TypeError("PETINFO_ROUTE_INVALID");
  if (!uint64(q.get("petid") ?? "") || !hexTicket(q.get("petsign") ?? "") || !cacheBuster(q.get("localtime") ?? "")) {
    throw new TypeError("PETINFO_IDENTITY_INVALID");
  }
  const request = { operation: "info", petId: q.get("petid"), sign: q.get("petsign"),
    // The cache-buster the client generates per submission: it is what makes one request
    // distinguishable from a later, deliberate request with the same target name.
    nonce: q.get("localtime") };
  if (cmd !== "10") {
    const field = cmd === "11" ? "pet_name" : "master_name";
    const value = q.get(field) ?? "";
    // The name travels URL-encoded UTF-8; the 15-byte GB18030 limit is the client's own
    // nickname contract (validateNickname enforces it precisely).
    if (value.length === 0 || value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new TypeError("PETINFO_NAME_INVALID");
    }
    request.operation = cmd === "11" ? "rename" : "master-rename";
    request.name = value;
  }
  return request;
}

export function petInfoXml(result, msg) {
  // The panel converts <result> to an integer: 0 succeeds, anything else restores the old
  // name and shows <msg>. Escaped so a message can never inject nodes into that parse.
  const escape = (value) => String(value).replace(/[&<>"']/gu,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
    `<PetInfo><result>${result}</result><msg>${escape(msg ?? "")}</msg></PetInfo>`;
}
