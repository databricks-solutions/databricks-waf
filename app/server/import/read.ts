// Getting an uploaded file off the wire, under a limit this route sets itself.
//
// The framework already installs a JSON body parser with a one-megabyte default, and inheriting it
// would be the wrong shape for this endpoint twice over. It would mean the highest-risk input in the
// app is parsed by a default somebody else chose and can change under us, and it would mean the
// parse happens before any of `parse.ts` gets a look — a body already turned into an object cannot be
// depth-checked, duplicate-key-checked, or capped, because all three are questions about text.
//
// So the endpoint accepts bytes rather than a JSON document. `Content-Type: application/octet-stream`
// is what the framework's parser declines to touch, which is how the stream arrives here unread. That
// is a real constraint on a caller using curl rather than the app's own page, so the refusal for the
// obvious mistake says what to send instead.
//
// Three checks, in the order a hostile caller meets them:
//
//   The declared length, when there is one, because refusing before reading is free.
//
//   The actual length as it arrives, because `Content-Length` is a claim by the sender. A header
//   saying 400 bytes followed by a gigabyte is the whole reason the second check is not the first
//   one made redundant.
//
//   That the bytes are UTF-8, decoded strictly. `Buffer.toString('utf8')` turns an invalid sequence
//   into U+FFFD without saying so, and the digest in the envelope is over the document a reader
//   understood — so a silently substituted character is a mismatch reported as tampering, when the
//   truth is that the file was mangled in transit or written in the wrong encoding.

/**
 * What this needs from a request, which is three things and not an Express `Request`.
 *
 * Narrow deliberately. The wide type asks a caller — including a test — to produce a hundred-odd
 * members to exercise a function that touches `headers`, `body` and the bytes, and the only way to do
 * that is a cast through `unknown`. A cast is not a shortcut here, it is a hole: the assertion is
 * checked by nothing, so a test can hand over an object that would never satisfy the real interface
 * and the function under test is being driven by something the type system has stopped describing.
 *
 * Stating the three members instead makes the fake a real value of a real type, and says what the
 * function actually depends on.
 */
export interface Uploaded extends AsyncIterable<Uint8Array> {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body?: unknown;
}

/**
 * The largest evidence file this endpoint will read.
 *
 * Sized against the envelope rather than guessed. The script's 29 probes project a few fields each,
 * and the two that scale with the estate are the cluster and job inventories: a thousand clusters at
 * six projected fields is about 150KB, so a large estate lands in the low megabytes and this leaves
 * several times that. It is deliberately not generous beyond that — the file is a projection, and one
 * arriving at fifty megabytes is not a large estate, it is not this script's output.
 */
export const MAX_BYTES = 8 * 1024 * 1024;

/** What the caller must send, so the framework's JSON parser leaves the stream alone. */
export const REQUIRED_CONTENT_TYPE = 'application/octet-stream';

export type UnreadableReason = 'already-parsed' | 'wrong-content-type' | 'too-large' | 'not-utf8' | 'read-failed';

export class UnreadableBodyError extends Error {
  constructor(
    readonly reason: UnreadableReason,
    message: string
  ) {
    super(message);
    this.name = 'UnreadableBodyError';
  }
}

/**
 * One header's value, or undefined.
 *
 * A header can arrive repeated, in which case Node hands over an array. Taking the first is the same
 * choice Express makes for everything except `set-cookie`; what matters here is that a repeated
 * `Content-Type` cannot slip past the check below by making the comparison happen against an array.
 */
function header(request: Uploaded, name: string): string | undefined {
  // Narrowed on the string rather than with `Array.isArray`, which widens a readonly array to `any[]`
  // and would hand back an `any` from a function whose whole job is to produce a string.
  const value = request.headers[name];
  return typeof value === 'string' ? value : value?.[0];
}

/**
 * The request body as text, or an `UnreadableBodyError` saying why not.
 *
 * `limit` is a parameter rather than a constant read from module scope so a test can drive the cap
 * with eight bytes instead of eight megabytes. It defaults to the real one, so a caller cannot get an
 * uncapped read by omitting it.
 */
export async function readUploaded(request: Uploaded, limit: number = MAX_BYTES): Promise<string> {
  // The declared type is checked before the already-parsed condition below, even though a body
  // arriving parsed is the more serious of the two. A caller who sent `Content-Type: application/json`
  // triggers both — the framework's parser claims the stream precisely because of the type — and of
  // the two answers, "send it as octet-stream" is the one they can act on. The other reads as an
  // internal fault, which for that caller it is not.
  const declared = header(request, 'content-type')?.split(';')[0]?.trim().toLowerCase();
  if (declared !== REQUIRED_CONTENT_TYPE) {
    throw new UnreadableBodyError(
      'wrong-content-type',
      `Send the file as ${REQUIRED_CONTENT_TYPE}, not ${declared == null || declared === '' ? 'an unstated type' : declared}. ` +
        'This endpoint reads the body as bytes so it can apply its own size limit and its own parse ' +
        'rules, and a body declared as JSON is parsed by the framework before either can run.'
    );
  }

  // A body that arrives already parsed means some middleware read the stream first, and every
  // guarantee below is then a claim about a stream that is gone. Failing here is the only honest
  // answer, and it fails loudly rather than falling back to `JSON.stringify(request.body)` — which
  // would look like it worked and would have re-serialised a document under this app's own rules,
  // erasing the duplicate keys and the exact bytes that the checks exist to examine.
  if (request.body != null && typeof request.body === 'object' && Object.keys(request.body).length > 0) {
    throw new UnreadableBodyError(
      'already-parsed',
      'The request body had already been parsed before this route read it, so it could not be capped ' +
        'or checked as text. That is a fault in how this app is assembled rather than in the upload: ' +
        `the route expects a ${REQUIRED_CONTENT_TYPE} body that no middleware claims.`
    );
  }

  const claimed = Number(header(request, 'content-length'));
  if (Number.isFinite(claimed) && claimed > limit) {
    throw new UnreadableBodyError(
      'too-large',
      `The upload declares ${describe(claimed)}, and this endpoint reads at most ${describe(limit)}. ` +
        tooLarge()
    );
  }

  const chunks: Buffer[] = [];
  let read = 0;

  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      read += bytes.length;
      // Checked per chunk and thrown from inside the loop, which ends the iteration and releases the
      // stream. Waiting until the end would mean a caller who lies about `Content-Length` gets to
      // decide how much memory this process uses, which is the attack the declared length cannot
      // close on its own.
      if (read > limit) {
        throw new UnreadableBodyError(
          'too-large',
          `The upload passed ${describe(limit)} while being read${
            Number.isFinite(claimed) ? `, having declared ${describe(claimed)}` : ''
          }. ${tooLarge()}`
        );
      }
      chunks.push(bytes);
    }
  } catch (cause) {
    if (cause instanceof UnreadableBodyError) throw cause;
    throw new UnreadableBodyError(
      'read-failed',
      `The upload stopped partway: ${cause instanceof Error ? cause.message : String(cause)}. Nothing ` +
        'was imported, so retrying is safe.'
    );
  }

  try {
    return strip(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new UnreadableBodyError(
      'not-utf8',
      'The upload is not valid UTF-8. The collection script writes UTF-8, so this file has been ' +
        're-encoded somewhere between there and here — which also means its digest can no longer ' +
        'establish anything about it. Send the file the script wrote.'
    );
  }
}

/**
 * A leading byte-order mark, removed.
 *
 * Not laxity for its own sake: `Set-Content` and several Windows editors add one, `JSON.parse` fails
 * on it with "Unexpected token", and a mark before the first brace changes nothing about what the
 * document says. Anywhere other than the front it is left alone, because there it is content.
 */
function strip(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

function tooLarge(): string {
  return (
    'An evidence file is a projection of a handful of fields per probe, so one this size is either ' +
    'not the script\u2019s output or comes from an estate larger than a single unpaged call describes. ' +
    'Re-run the script and send the file it writes.'
  );
}

function describe(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
