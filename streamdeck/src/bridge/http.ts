/** Small fetch helpers shared by the bridge client and the sprite cache. */

export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Response larger than ${limit} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Reads a response body into memory, refusing (and cancelling the transfer)
 * once it exceeds `maxBytes` — `response.text()` would buffer whatever a
 * hostile server chooses to send.
 */
export async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder('utf-8').decode(await readBoundedBytes(response, maxBytes));
}

/** Discards a body we will not read, so the connection can be reused or closed. */
export function discardBody(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}
