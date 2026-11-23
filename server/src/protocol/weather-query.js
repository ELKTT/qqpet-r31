export const WEATHER_QUERY_COMMAND = 0x1501;
export function decodeWeatherQueryRequest(body) {
  if(!Buffer.isBuffer(body) || body.length!==4)throw new TypeError('INVALID_WEATHER_QUERY_REQUEST');
  return {type:'WeatherQueryRequest',queryWord:body.readUInt32BE(0)};
}
export function encodeWeatherQueryFailure(result) {
  if(!Number.isInteger(result) || result<1 || result>65535)throw new TypeError('INVALID_WEATHER_FAILURE');
  const body=Buffer.alloc(2);body.writeUInt16BE(result);return body;
}
