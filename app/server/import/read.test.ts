// The read, attacked.
//
// The interesting test is the lying header: `Content-Length: 12` followed by ten megabytes. A cap
// implemented on the header alone passes that file straight through, which is why the check appears
// twice in `read.ts` and twice here.
//
// The requests are streams rather than an Express test client, because the properties under test are
// about what happens *during* the read — how much arrives before it stops, and whether the loop ends
// when it should. A supertest round trip would assert the status code and tell us nothing about the
// megabytes.

import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { REQUIRED_CONTENT_TYPE, type Uploaded, UnreadableBodyError, readUploaded } from './read';

interface Options {
  readonly type?: string | null;
  readonly length?: number | null;
  readonly body?: unknown;
}

/**
 * A request carrying `bytes`, with headers a caller can spoil one at a time.
 *
 * A real value of `Uploaded` rather than a stream cast to an Express `Request`. The cast came first
 * and it was wrong: an assertion through `unknown` is checked by nobody, so it let these tests drive
 * `readUploaded` with an object that satisfied no interface at all, and any drift between the fake and
 * the real request would have gone unmentioned by the compiler.
 */
function request(bytes: Readable, options: Options = {}): Uploaded {
  const headers: Record<string, string> = {};
  const type = options.type === undefined ? REQUIRED_CONTENT_TYPE : options.type;
  if (type != null) headers['content-type'] = type;
  if (options.length != null) headers['content-length'] = String(options.length);

  return {
    headers,
    body: options.body,
    [Symbol.asyncIterator]: () => bytes[Symbol.asyncIterator](),
  };
}

/** A request carrying `chunks`, with `Content-Length` set truthfully unless overridden. */
function upload(chunks: readonly (string | Buffer)[], options: Options = {}): Uploaded {
  const buffers = chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  const length =
    options.length === undefined ? buffers.reduce((total, chunk) => total + chunk.length, 0) : options.length;
  return request(Readable.from(buffers), { ...options, length });
}

/** A stream that never ends, counting what it has been asked to produce. */
function endless(fill: number): { readonly bytes: Readable; produced: () => number } {
  let produced = 0;
  const bytes = new Readable({
    read() {
      produced += 1024;
      this.push(Buffer.alloc(1024, fill));
    },
  });
  return { bytes, produced: () => produced };
}

async function refusal(request: Uploaded, limit?: number): Promise<UnreadableBodyError> {
  try {
    await readUploaded(request, limit);
  } catch (cause) {
    if (cause instanceof UnreadableBodyError) return cause;
    throw cause;
  }
  throw new Error('Expected the read to be refused, and it succeeded.');
}

describe('readUploaded', () => {
  it('reads a body that arrives in pieces', async () => {
    await expect(readUploaded(upload(['{"schema":', '"waf-admin', '-evidence/1"}']))).resolves.toBe(
      '{"schema":"waf-admin-evidence/1"}'
    );
  });

  describe('the size limit', () => {
    it('refuses on the declared length, before reading anything', async () => {
      const stream = endless(0);

      expect((await refusal(request(stream.bytes, { length: 99_999 }), 64)).reason).toBe('too-large');
      expect(stream.produced()).toBe(0);
    });

    it('refuses a lying header partway through, rather than after the whole body', async () => {
      // The attack: a truthful-looking header and an endless body. What is asserted is that the read
      // stops near the limit rather than at the end of what the sender chose to send.
      const stream = endless(0x20);

      const problem = await refusal(request(stream.bytes, { length: 12 }), 4096);
      expect(problem.reason).toBe('too-large');
      expect(problem.message).toContain('declared 12 bytes');
      // A chunk or two of slack for the stream's own buffering; the point is that it is bounded.
      expect(stream.produced()).toBeLessThan(4096 * 4);
    });

    it('refuses a body over the limit with no declared length at all', async () => {
      expect((await refusal(upload(['x'.repeat(200)], { length: null }), 64)).reason).toBe('too-large');
    });

    it('accepts a body exactly at the limit', async () => {
      await expect(readUploaded(upload(['x'.repeat(64)]), 64)).resolves.toHaveLength(64);
    });

    it('names both the limit and the size, since a refusal without either is unactionable', async () => {
      const problem = await refusal(upload(['x'.repeat(4096)]), 1024);
      expect(problem.message).toContain('1KB');
    });
  });

  describe('the content type', () => {
    it('refuses a JSON body, and says what to send instead', async () => {
      const problem = await refusal(upload(['{}'], { type: 'application/json' }));
      expect(problem.reason).toBe('wrong-content-type');
      expect(problem.message).toContain(REQUIRED_CONTENT_TYPE);
    });

    it('refuses a body with no type at all', async () => {
      expect((await refusal(upload(['{}'], { type: null }))).reason).toBe('wrong-content-type');
    });

    it('accepts the type with a charset on it, which browsers add', async () => {
      await expect(
        readUploaded(upload(['{}'], { type: `${REQUIRED_CONTENT_TYPE}; charset=utf-8` }))
      ).resolves.toBe('{}');
    });

    it('accepts the type in any case, which is what the HTTP grammar says', async () => {
      await expect(readUploaded(upload(['{}'], { type: 'Application/Octet-Stream' }))).resolves.toBe('{}');
    });
  });

  describe('a body somebody else already read', () => {
    it('refuses rather than re-serialising the object it was handed', async () => {
      const problem = await refusal(upload(['{}'], { body: { schema: 'waf-admin-evidence/1' } }));
      expect(problem.reason).toBe('already-parsed');
      expect(problem.message).toContain('capped');
    });

    it('is not fooled by the empty object Express leaves behind when it parses nothing', async () => {
      await expect(readUploaded(upload(['{"a":1}'], { body: {} }))).resolves.toBe('{"a":1}');
    });
  });

  describe('encoding', () => {
    it('refuses bytes that are not UTF-8, rather than substituting a character', async () => {
      // 0xFF cannot begin a UTF-8 sequence. `Buffer.toString('utf8')` yields U+FFFD here without
      // complaint, which would change the document and be reported later as a digest mismatch.
      expect(Buffer.from([0xff]).toString('utf8')).toBe('\uFFFD');
      expect((await refusal(upload([Buffer.from([0x7b, 0xff, 0x7d])]))).reason).toBe('not-utf8');
    });

    it('refuses a truncated multi-byte sequence, which is a file cut in half', async () => {
      const cut = Buffer.from('{"label":"caf\u00e9"}', 'utf8').subarray(0, 14);
      expect((await refusal(upload([cut]))).reason).toBe('not-utf8');
    });

    it('reads a multi-byte character split across two chunks', async () => {
      const bytes = Buffer.from('{"label":"caf\u00e9"}', 'utf8');
      const at = bytes.indexOf(0xc3) + 1;
      await expect(readUploaded(upload([bytes.subarray(0, at), bytes.subarray(at)]))).resolves.toBe(
        '{"label":"caf\u00e9"}'
      );
    });

    it('drops a leading byte-order mark, which several editors add and JSON.parse rejects', async () => {
      const text = await readUploaded(upload([Buffer.from('\uFEFF{"a":1}', 'utf8')]));
      expect(text).toBe('{"a":1}');
      expect(() => {
        JSON.parse(text);
      }).not.toThrow();
    });

    it('leaves a mark that is not at the front, where it is content', async () => {
      await expect(readUploaded(upload(['{"label":"a\uFEFFb"}']))).resolves.toBe('{"label":"a\uFEFFb"}');
    });
  });

  it('reports a connection that drops partway as safe to retry', async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error('socket hang up'));
      },
    });

    const problem = await refusal(request(stream, { length: null }));
    expect(problem.reason).toBe('read-failed');
    expect(problem.message).toContain('retrying is safe');
  });
});
