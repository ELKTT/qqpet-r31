// Query-bearing movie URLs present in the hash-pinned active NpcList files.
// Keep id in the browser URL: the original child movie reads its loader parameters.
export function acceptsCommunityResourceQuery(pathname,search) {
  if(search==='')return true;
  const name=pathname.toLowerCase();
  if(name==='/community/assets/data/wilderness/main_sq_tasknew.swf')
    return /^\?id=(108|110|112)$/.test(search);
  if(name==='/community/assets/data/wilderness/sq_npc_talk.swf')
    return /^\?id=[1-8]$/.test(search);
  return false;
}
