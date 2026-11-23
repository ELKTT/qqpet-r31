export const DAILY_TASK_INFO_COMMAND = 0x2203;

export function decodeDailyTaskInfoRequest(body) {
  if (!Buffer.isBuffer(body) || body.length !== 0) throw new TypeError('INVALID_DAILY_TASK_REQUEST');
  return {type: 'DailyTaskInfoRequest'};
}

export function encodeDailyTaskInfoResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 ||
      Object.keys(value).some(key => !['noticeCount', 'onlineGiftPrizeCount', 'currentBonusDay', 'unknownTag4Hex'].includes(key))) {
    throw new TypeError('INVALID_DAILY_TASK_PROFILE');
  }
  for (const name of ['noticeCount', 'onlineGiftPrizeCount', 'currentBonusDay']) {
    if (!Number.isInteger(value?.[name]) || value[name] < 0 || value[name] > 0x7fffffff) {
      throw new TypeError('INVALID_DAILY_TASK_VALUE');
    }
  }
  if (!/^[0-9a-f]{8}$/i.test(value.unknownTag4Hex ?? '')) throw new TypeError('INVALID_DAILY_TASK_UNKNOWN');
  // All four tags are explicit. There is no result word or missing-tag fallback.
  const body = Buffer.alloc(26);
  body.writeUInt16BE(4);
  [value.noticeCount, value.onlineGiftPrizeCount, value.currentBonusDay].forEach((word, index) => {
    body.writeUInt16BE(index + 1, 2 + index * 6);
    body.writeUInt32BE(word, 4 + index * 6);
  });
  body.writeUInt16BE(4, 20);
  Buffer.from(value.unknownTag4Hex, 'hex').copy(body, 22);
  return body;
}
