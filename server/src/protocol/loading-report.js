export const LOADING_REPORT_COMMAND = 0x0584;
// Authority encoder writes ten BE32 words and 16 raw bytes. Reporting is
// one-way; validate its framing but retain none of its potentially identifying data.
export function decodeLoadingReport(body) {
  if(!Buffer.isBuffer(body) || body.length!==56)throw new TypeError('INVALID_LOADING_REPORT');
  return {type:'LoadingReport'};
}
