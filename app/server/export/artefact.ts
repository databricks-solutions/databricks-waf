// A file taken out of this app, and the digest that lets somebody who was not here check it.
//
// # Why this is a module and not four lines in the route
//
// An export leaves. It is attached to an email, put in a shared drive, quoted in a board paper, and
// read a year later by somebody who cannot ask this app anything. Everything else the app produces
// can be re-derived by asking again; this is the one artefact whose only evidence of being genuine
// is the artefact itself.
//
// That is only worth anything if the bytes are a function of the record rather than of the request. A
// file with the time of download in it has a different digest every time, so a recipient comparing
// their copy with the digest we recorded learns nothing: a mismatch could be tampering or could be
// Tuesday. Removing the timestamp (`documentVersion` 2) is what makes the digest a statement about
// content, and this module is where the two halves — the bytes and the digest over them — are produced
// together, so a route cannot record a digest of something other than what it sent.
//
// What the bytes *are* a function of is the stored run and the decisions standing against it. The
// second of those moves, so a digest is stable for a state of the record and not for all time; that
// is the file working rather than a hole in it, and the run page says so to the one reader it could
// mislead. Sealing an export once when its run finishes was considered and refused: it is the version
// of this with a permanent digest and a worse file, since it could never carry a decision taken after
// the run. ADR 0050's amendment records the decision.
//
// The digest is the plain SHA-256 of the bytes as sent, not of a canonical form of the document.
// A recipient runs `shasum -a 256` on the file they hold. Canonicalisation is for records this app
// stores and re-reads through a database that reorders keys; a file has no such round trip, and a
// digest a recipient cannot reproduce with one command is a digest nobody checks.
//
// See ADR 0050. Managed-key signatures over these bytes are the second half of the same audit
// requirement (AUD-DEC-105B) and are deliberately not here: a signature needs a key whose custody
// somebody has decided on, and a digest recorded in the trail is what makes that decision
// deferrable rather than blocking.

import { fromBytes, hexOf, type Digest } from '../records/digest.js';
import { assessmentCsv, assessmentDocument, exportName, type ExportOptions } from './document.js';
import {
  DEFAULT_PLAN_VARIANT,
  planCsv,
  planDocument,
  planExportName,
  type PlanExportOptions,
  type PlanVariant,
} from './plan-document.js';
import { DEFAULT_VARIANT, type ExportVariant } from './variant.js';

/**
 * The digest of the body, sent with the body.
 *
 * So a client that downloaded the file can check it without a second request, and so a proxy log
 * shows what was served. Named after `X-Evidence-Script-Digest`, which does the same job for the
 * collection script, rather than RFC 9530's `Repr-Digest` — the value here is the `sha256:…` string
 * this app writes everywhere else, and a standard header carrying a non-standard encoding of its
 * value would be worse than an obviously local one.
 */
export const DIGEST_HEADER = 'X-Export-Digest';

/** The format of a file, which decides its media type and its shape. */
export type ExportFormat = 'csv' | 'json';

/**
 * A file this app produced, ready to send and ready to record.
 *
 * Generic in its variant so that the two documents this app publishes can share one shape without
 * sharing one vocabulary. An assessment has four readers and a plan has three, and they are not the
 * same three — see the variants section of `plan-document.ts` for why `technical` means nothing to a
 * plan. A single union of all seven words would let a route seal an assessment as `delivery`.
 */
export interface Artefact<TVariant extends string = ExportVariant> {
  /**
   * The name it is offered under: the date, the run and the variant, so two downloads can be told
   * apart and a recipient checking a digest knows which file it was published for.
   */
  readonly name: string;
  readonly format: ExportFormat;
  /** Who it is for, which decides what it carries. See `variant.ts` and `plan-document.ts`. */
  readonly variant: TVariant;
  /** Explicit, because `nosniff` makes the declaration binding and a download is not a page. */
  readonly contentType: string;
  readonly bytes: Buffer;
  /** `sha256:…` over `bytes` exactly as sent. */
  readonly digest: Digest;
}

const CONTENT_TYPE: Readonly<Record<ExportFormat, string>> = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

/** Build an assessment's file and digest it. `sealed` below carries the rule both entry points obey. */
export function seal(options: ExportOptions & { readonly format: ExportFormat }): Artefact {
  const { format } = options;
  const variant = options.variant ?? DEFAULT_VARIANT;
  const text = format === 'csv' ? assessmentCsv(options) : JSON.stringify(assessmentDocument(options), null, 2);

  return sealed(exportName(options.scan, format, variant), format, variant, text);
}

/**
 * Build an improvement plan's file and digest it.
 *
 * A second entry point rather than a `kind` on the first, because the two documents are built from
 * different records and a function that took either would take a union its body had to narrow — and
 * the narrowing is the place a route ends up able to ask for the assessment of a plan.
 *
 * What the two share is this module's one invariant, which is why they both end up in `sealed`: the
 * bytes and the digest over them are produced together, so no route can record a digest of something
 * other than what it sent.
 */
export function sealPlan(options: PlanExportOptions & { readonly format: ExportFormat }): Artefact<PlanVariant> {
  const { format } = options;
  const variant = options.variant ?? DEFAULT_PLAN_VARIANT;
  const text = format === 'csv' ? planCsv(options) : JSON.stringify(planDocument(options), null, 2);

  return sealed(planExportName(options.plan, format, variant), format, variant, text);
}

/**
 * The bytes, and the digest over exactly those bytes.
 *
 * The JSON is pretty-printed with two spaces, and that is part of what is digested. A recipient
 * checking a file has to hash the bytes they were sent, so the indentation is as much a part of the
 * format as the field names are — reformatting the output is a change of document version, not a
 * change of presentation.
 */
function sealed<TVariant extends string>(
  name: string,
  format: ExportFormat,
  variant: TVariant,
  text: string
): Artefact<TVariant> {
  const bytes = Buffer.from(text, 'utf8');

  return {
    name,
    format,
    variant,
    contentType: CONTENT_TYPE[format],
    bytes,
    digest: fromBytes(bytes),
  };
}

/**
 * What a recipient runs to check the file, in the words they would use.
 *
 * Here rather than in the client, because the client is not the only reader of it — the same sentence
 * belongs beside a digest wherever one is shown, including in a report a person pastes into an email
 * to whoever they sent the file to. Both commands rather than the shorter one: `shasum` is macOS,
 * `sha256sum` is most Linux, and telling somebody to run the one they do not have is how a
 * verification step gets skipped.
 */
export function howToCheck(artefact: Pick<Artefact, 'name' | 'digest'>): readonly string[] {
  return [`shasum -a 256 ${artefact.name}`, `sha256sum ${artefact.name}`, `# expect ${hexOf(artefact.digest)}`];
}
