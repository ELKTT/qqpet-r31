// Root notifications are small frames. A slow peer must not turn broadcasts
// into an unlimited process-wide send backlog. The normal socket high-water
// mark may be exceeded briefly; this is the independent hard queue ceiling.
export const MAX_GAME_QUEUED_BYTES=1024*1024;
export function writeGameFrame(socket,frame){
  if(socket.destroyed||socket.writable===false)return false;
  const size=Buffer.isBuffer(frame)?frame.length:Buffer.byteLength(frame);
  if((socket.writableLength??0)+size>MAX_GAME_QUEUED_BYTES){socket.destroy();return false;}
  socket.write(frame);
  return true;
}
