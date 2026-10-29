// What a reader outside the assessor group is shown in place of the fields they may not see.
//
// Decision D1 in docs/decisions.md. Published results, scores, findings outcomes and summaries stay
// readable by every app user. Three kinds of field are shown only to direct members of the assessor
// group, because the run that produced them read the estate as whoever started it, so what it wrote down
// is not bounded by the grants of the person reading it back:
//
//  - statement text, in advisories;
//  - principal identifiers in findings evidence: the holders of tokens, and the accounts jobs run as;
//  - an administrator's imported readings, and who collected them.
//
// Every other reader gets a typed placeholder in the same place, `WithheldPayload`, which says what was
// withheld and who can see it.
//
// # A function of the stored record
//
// The projection runs when a record is read and never when it is written. Stored scans, published results
// and their digests are untouched, and a record written before this existed is covered the day it is
// read. That is also why principal evidence is recognised by the signal it was read from rather than by a
// flag the resolver set: a flag would only exist on the records written after it was added.
//
// # What is not restricted
//
// The attribution of an ordinary reading (`provenance.actor` on evidence the app took) is the same
// identity every scan summary and history row already names, and is not one of the three kinds above.
// Outcomes, scores, coverage and the evidence that names no one are returned as they are.
//
// # Exports
//
// The same projection is applied to the scan an export is built from, before it is sealed. A file the
// reader downloads therefore carries the placeholders, and its digest is the digest of those bytes: the
// digest listed beside a file and the digest of the download are computed from the same projected scan.

import type {
  AssessmentResultPayload,
  AssessmentReviewPayload,
  EvidenceImportPayload,
  ScanPayload,
  SignalPayload,
  WithheldKind,
  WithheldPayload,
} from '../../shared/api/contract.js';
import { JOBS, RUN_AS_USER_LEAD } from '../resolve/resolvers/security-jobs.js';
import { TOKENS } from '../resolve/resolvers/security-settings.js';
import type { Scan } from '../scan/scan.js';

/** Who is reading, and the group that decides what they may see. */
export interface Reader {
  /** Whether the caller is a direct member of the assessor group. */
  readonly assessor: boolean;
  /** The group's name, which a placeholder gives so the reader knows who to ask. */
  readonly group: string;
}

const WHAT: Readonly<Record<WithheldKind, string>> = {
  'statement-text': 'Statement text is withheld.',
  'principal-identifiers': 'The names of the users, service principals and token creators here are withheld.',
  'admin-reading': 'An administrator’s imported reading is withheld.',
};

/** The placeholder for one kind of field, naming the group whose members can see it. */
export function withheldFrom(kind: WithheldKind, group: string): WithheldPayload {
  return {
    withheld: kind,
    reason: `${WHAT[kind]} Only direct members of the ${group} group can see it.`,
    visibleTo: group,
  };
}

/** The record without the named fields, so a withheld value is absent rather than present and blanked. */
function without<T extends object, K extends keyof T>(record: T, fields: readonly K[]): Omit<T, K> {
  const dropped: readonly PropertyKey[] = fields;
  return Object.fromEntries(Object.entries(record).filter(([name]) => !dropped.includes(name))) as Omit<T, K>;
}

/** The parts of a piece of evidence the projection reads, on the stored record and on the wire alike. */
interface EvidenceView {
  readonly signal: string;
  readonly observed: string;
  readonly bearing?: 'outcome' | 'detail' | undefined;
  readonly evidenceClass?: string | undefined;
  readonly at?: { readonly lead: string } | undefined;
  readonly provenance?: { readonly authority: string } | undefined;
  readonly withheld?: WithheldPayload | undefined;
}

/**
 * Whether this evidence lists the principals behind a finding.
 *
 * The token inventory's detail evidence says who holds each token, and the job inventory's detail
 * evidence under the run-as lead says which account each job runs as. Nothing else a resolver writes
 * onto a finding names a principal; `projection.test.ts` holds the resolver sources to that.
 */
export function carriesPrincipals(evidence: EvidenceView): boolean {
  if (evidence.bearing !== 'detail') return false;
  if (evidence.signal === TOKENS) return true;
  return evidence.signal === JOBS && evidence.at?.lead === RUN_AS_USER_LEAD;
}

/** Whether an administrator read this and imported it, rather than the app reading it. */
function isImportedReading(evidence: {
  readonly evidenceClass?: string | undefined;
  readonly provenance?: { readonly authority: string } | undefined;
}): boolean {
  return evidence.evidenceClass === 'admin-collected' || evidence.provenance?.authority === 'admin-cli';
}

/**
 * One piece of evidence as this reader may see it.
 *
 * What is withheld is the sentence and the structured copy of it: `observed` becomes the placeholder's
 * reason, and `at` goes, because its items carry the same names. For an imported reading `provenance`
 * goes as well, since its actor is the administrator. What was expected, the coverage, the signal and
 * the time stay, so the evidence still says what it was about and how much of the estate it covered.
 */
export function projectEvidence<E extends EvidenceView>(
  evidence: E,
  reader: Reader
): E & { readonly withheld?: WithheldPayload } {
  if (reader.assessor) return evidence;

  const kind: WithheldKind | undefined = isImportedReading(evidence)
    ? 'admin-reading'
    : carriesPrincipals(evidence)
      ? 'principal-identifiers'
      : undefined;
  if (kind == null) return evidence;

  const placeholder = withheldFrom(kind, reader.group);
  const kept = kind === 'admin-reading' ? without(evidence, ['at', 'provenance']) : without(evidence, ['at']);
  return { ...kept, observed: placeholder.reason, withheld: placeholder } as E & { readonly withheld?: WithheldPayload };
}

/** The findings of a record with each one's evidence projected, and every other field as it was. */
export function projectFindings<F extends { readonly evidence: readonly EvidenceView[] }>(
  findings: readonly F[],
  reader: Reader
): readonly F[] {
  if (reader.assessor) return findings;
  return findings.map((finding) => {
    const evidence = finding.evidence.map((one) => projectEvidence(one, reader));
    return evidence.some((one, index) => one !== finding.evidence[index]) ? { ...finding, evidence } : finding;
  });
}

/** A scan as an export is built from it, so a file cannot carry what a reader may not see. */
export function projectScan(scan: Scan, reader: Reader): Scan {
  if (reader.assessor) return scan;
  const findings = projectFindings(scan.findings, reader);
  return findings === scan.findings ? scan : { ...scan, findings };
}

/**
 * The summary of a signal as this reader may see it.
 *
 * For an imported reading that is its fact of having been read and imported, without who read it or what
 * the administrator's own refusal said.
 */
export function projectSignal(signal: SignalPayload, reader: Reader): SignalPayload {
  if (reader.assessor || !isImportedReading(signal)) return signal;
  return { ...without(signal, ['provenance', 'unmeasurableReason']), withheld: withheldFrom('admin-reading', reader.group) };
}

export function projectScanPayload(payload: ScanPayload<Date>, reader: Reader): ScanPayload<Date> {
  if (reader.assessor) return payload;
  return {
    ...payload,
    findings: projectFindings(payload.findings, reader),
    signals: payload.signals.map((signal) => projectSignal(signal, reader)),
  };
}

/** The final result as a reader sees it: the frozen findings, with their evidence projected. */
export function projectResultPayload(
  payload: AssessmentResultPayload<Date>,
  reader: Reader
): AssessmentResultPayload<Date> {
  if (reader.assessor || payload.finalAssessment == null) return payload;
  const { outcome } = payload.finalAssessment;
  return {
    ...payload,
    finalAssessment: {
      ...payload.finalAssessment,
      outcome: {
        ...outcome,
        findings: outcome.findings.map((one) => {
          const [finding] = projectFindings([one.finding], reader);
          return finding === one.finding ? one : { ...one, finding: finding ?? one.finding };
        }),
      },
    },
  };
}

/** A review whose frozen result, where it has one, is projected. */
export function projectReviewPayload(
  payload: AssessmentReviewPayload<Date>,
  reader: Reader
): AssessmentReviewPayload<Date> {
  if (reader.assessor || payload.result == null) return payload;
  return { ...payload, result: projectResultPayload(payload.result, reader) };
}

/** A shape that may carry statement text, on an advisory as stored and as sent. */
interface StatementShape {
  readonly shape: string;
  readonly statementText?: string | undefined;
  readonly statementWithheld?: WithheldPayload | undefined;
}

function projectStatement<T extends StatementShape>(shape: T, reader: Reader): T {
  if (shape.statementText == null) return shape;
  return { ...without(shape, ['statementText']), statementWithheld: withheldFrom('statement-text', reader.group) } as T;
}

/** The two lists of an advisory that hold shapes with text: the workload's and the writes'. */
interface StatementBearing {
  readonly workload?: { readonly top: readonly StatementShape[]; readonly failing: readonly StatementShape[] } | undefined;
  readonly writes?: { readonly shapes: readonly StatementShape[] } | undefined;
}

/** An advisory with the statement text of every shape it lists replaced. */
export function projectAdvisoryPayload<A extends StatementBearing>(payload: A, reader: Reader): A {
  if (reader.assessor) return payload;
  const { workload, writes } = payload;
  return {
    ...payload,
    ...(workload != null
      ? {
          workload: {
            ...workload,
            top: workload.top.map((shape) => projectStatement(shape, reader)),
            failing: workload.failing.map((shape) => projectStatement(shape, reader)),
          },
        }
      : {}),
    ...(writes != null ? { writes: { ...writes, shapes: writes.shapes.map((shape) => projectStatement(shape, reader)) } } : {}),
  };
}

/** An import's list entry, without who ran the script that collected it. */
export function projectImportPayload(payload: EvidenceImportPayload, reader: Reader): EvidenceImportPayload {
  if (reader.assessor || payload.collectedBy == null) return payload;
  return { ...without(payload, ['collectedBy']), collectedByWithheld: withheldFrom('principal-identifiers', reader.group) };
}
