import type { TsaClient } from '../../application/batch-service.ts';
import { requestTimestamp, type TsaAuth } from './rfc3161.ts';

/** Adaptador del puerto TsaClient sobre una TSA HTTP RFC 3161, con autenticación básica opcional. */
export function httpTsaClient(url: string, auth?: TsaAuth): TsaClient {
  return {
    async request(digest) {
      const info = await requestTimestamp(digest, url, fetch, auth);
      return { tokenDer: info.tokenDer, genTime: info.genTime };
    },
  };
}
