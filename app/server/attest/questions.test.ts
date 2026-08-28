// Every requirement the app puts to a person has a question worth answering.
//
// This is the test that keeps the feature honest. The catalogue's attestation questions were
// generated from titles — `"<title>: is this practice in place?"` — which produced eighty
// questions a well-run organisation and a badly-run one answer identically. Those answers then
// move the score, so a bad question is worse than no question: an unmeasured requirement at
// least reports itself as unknown.
//
// So the shape is checked mechanically, and the checks are the ones that catch a placeholder:
// nothing may carry the generated template, everything must name what the answer rests on, and
// nothing may stand for longer than the practice plausibly holds.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { beyondAnyInstall, descriptorsById } from '../plan/plan.js';
import { BLOCKED_QUESTIONS } from './blocked-questions.js';

const catalogue = loadCatalogue();
const registry = buildRegistry();
const descriptors = descriptorsById();

/** Requirements answered by a person because no telemetry reaches them, for anyone. */
const byPractice = catalogue.controls.filter((control) => control.measurability === 'attestation');

/** Requirements this app checks, and that no install of it can be authorised to run. */
const byAuthorisation = catalogue.controls.filter(
  (control) => control.measurability !== 'attestation' && beyondAnyInstall(control, registry, descriptors)
);

/**
 * Requirements out of reach for a reason `beyondAnyInstall` cannot see, listed rather than derived.
 *
 * That function reasons about the signals a requirement needs: where every one of them wants a scope
 * no install is granted, nothing can ever be read. It is right about the 40 it finds and blind to a
 * resolver whose signals all answer and which then finds the specific thing asked about unreadable.
 *
 * SCP-03-07 is the one such case. The serving census answers, so the resolver knows endpoints exist
 * and the requirement applies; whether they are shielded needs `networking` and the account plane,
 * so no verdict follows. Establishing that here would mean resolving the control against a fixture,
 * which `api/attest-reach.test.ts` already does — it proves the finding asks for an answer and that
 * the answers page offers a slot for it. This list exists so that a second entry is a decision
 * somebody makes on purpose rather than a way around a failing assertion.
 */
const FOUND_BY_RESOLVING: readonly string[] = ['SCP-03-07'];

/** The generated shape, in the forms it took. Any of these is a placeholder, not a question. */
const TEMPLATES = [/is this practice in place\?$/, /is this in place across the workspace\?$/];

describe('the questions put to a person about practice', () => {
  it('covers every requirement the catalogue says only a person can answer', () => {
    const missing = byPractice.filter((control) => control.attestation?.question == null);
    expect(missing.map((control) => control.id)).toEqual([]);
    // A guard on the guard: if the catalogue stopped classifying anything as attestation the
    // assertion above would pass by asking nothing, and the feature would be silently gone.
    //
    // The bound came down from 70 when the operational-excellence and interoperability pillars
    // were measured. Both arrived entirely attestation-class — the seed's default for pillars
    // whose published text is about process — and nineteen of their controls turned out to name
    // an observable artefact of that process. It came down again to 45 when row 37g measured the
    // three model-lifecycle questions off `system.serving` and `system.mlflow`. It should keep
    // coming down as more are measured, so this is a floor against the feature vanishing, not a
    // target.
    expect(byPractice.length).toBeGreaterThan(45);
  });

  it('asks nothing in the generated form, which cannot be answered wrongly', () => {
    const generated = byPractice.filter((control) =>
      TEMPLATES.some((template) => template.test(control.attestation?.question ?? ''))
    );
    expect(generated.map((control) => control.id)).toEqual([]);
  });

  it('names what the answer should rest on, so an evidence link means something', () => {
    const unguided = byPractice.filter((control) => (control.attestation?.evidenceGuidance ?? '').length < 40);
    expect(unguided.map((control) => control.id)).toEqual([]);
  });

  it('reviews every answer at least yearly, because a practice attested once is a claim about the past', () => {
    const forever = byPractice.filter((control) => (control.attestation?.cadenceDays ?? Infinity) > 365);
    expect(forever.map((control) => control.id)).toEqual([]);
  });

  it('asks a question rather than restating the title', () => {
    const notAsked = byPractice.filter((control) => !(control.attestation?.question ?? '').includes('?'));
    expect(notAsked.map((control) => control.id)).toEqual([]);
  });
});

describe('the questions put to a person about a setting no install can read', () => {
  it('covers every requirement blocked by authorisation rather than by measurability', () => {
    const missing = byAuthorisation.filter((control) => BLOCKED_QUESTIONS[control.id] == null);
    expect(missing.map((control) => control.id)).toEqual([]);
  });

  it('asks about nothing the app can actually measure, so a person is never asked to duplicate a reading', () => {
    const blockedIds = new Set([...byAuthorisation.map((control) => control.id), ...FOUND_BY_RESOLVING]);
    const spurious = Object.keys(BLOCKED_QUESTIONS).filter((id) => !blockedIds.has(id));
    expect(spurious).toEqual([]);
  });

  it('reviews an answer about a setting quarterly, because a setting changes in one click', () => {
    // The four exceptions are the facts fixed when a workspace is built — customer-managed keys,
    // a customer-managed VPC, front-end Private Link, secure cluster connectivity. Several cannot
    // be changed afterwards at all, so a quarterly question about them is one the reader learns to
    // click through, and that habit is what costs an answer its value. Listed rather than derived
    // so that adding a fifth is a decision somebody makes on purpose.
    const fixedAtCreation = new Set(['SCP-02-03', 'SCP-03-03', 'SCP-03-04', 'SCP-03-06']);
    const stale = Object.entries(BLOCKED_QUESTIONS).filter(
      ([id, question]) => question.cadenceDays > 90 && !fixedAtCreation.has(id)
    );
    expect(stale.map(([id]) => id)).toEqual([]);
  });

  it('reviews even those yearly, so no answer about this workspace stands indefinitely', () => {
    const forever = Object.entries(BLOCKED_QUESTIONS).filter(([, question]) => question.cadenceDays > 365);
    expect(forever.map(([id]) => id)).toEqual([]);
  });

  it('asks a question rather than restating the setting', () => {
    const notAsked = Object.entries(BLOCKED_QUESTIONS).filter(([, question]) => !question.question.includes('?'));
    expect(notAsked.map(([id]) => id)).toEqual([]);
  });

  it('says where to look, since the reader is being asked to read a screen the app cannot', () => {
    const vague = Object.entries(BLOCKED_QUESTIONS).filter(([, question]) => question.evidence.length < 40);
    expect(vague.map(([id]) => id)).toEqual([]);
  });
});
