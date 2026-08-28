// The operating inbox reports dates and counts already carried by the records it joins.
// It does not infer whether a scheduled run will arrive, whether an owner will act, or whether
// improvement work changed the assessment. Those claims belong to fields the inbox does not have.

import type { AssessmentReview, ScanSummary } from '../api/types';
import { duration } from './run-language';

export function remainingPhrase(recorded: number, expected: number): string {
  if (expected <= 0) return 'Work remaining unavailable';
  const remaining = Math.max(0, expected - recorded);
  if (remaining === 0) return 'Every selected pillar recorded';
  return `${String(remaining)} ${remaining === 1 ? 'pillar' : 'pillars'} left`;
}

export function openAge(openedAt: string, now: Date): string {
  const opened = new Date(openedAt).getTime();
  const elapsed = now.getTime() - opened;
  if (!Number.isFinite(opened) || !Number.isFinite(elapsed) || elapsed < 0) return 'Open age unavailable';

  const hours = Math.floor(elapsed / 3_600_000);
  if (hours === 0) return 'Open less than an hour';
  if (hours < 24) return `Open ${String(hours)} ${hours === 1 ? 'hour' : 'hours'}`;

  const days = Math.floor(hours / 24);
  return `Open ${String(days)} ${days === 1 ? 'day' : 'days'}`;
}

export function reviewTiming(review: AssessmentReview, scan: ScanSummary | undefined, now: Date): string {
  const opened = `${openAge(review.openedAt, now)} · opened by ${review.openedBy}`;
  if (scan == null) return `Collected run timing unavailable · ${opened}`;
  return `Finished ${dateTime(scan.finishedAt)} · took ${duration(scan)} · ${opened}`;
}

export function dateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'an unrecorded date';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
