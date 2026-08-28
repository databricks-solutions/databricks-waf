// The shape every Optimisation page reads the advisor through.
//
// Its own context beside the assessment's rather than more fields on it, and the reason is the same
// one that gave the advisor its own routes, its own history and its own retention period (ADR 0061).
// A single context would give the two cycles one `loading`, one `error` and one running state, and
// the visible consequence is a header that says the estate is being measured while the advisor runs
// and a score that looks stale for the duration.
//
// Kept apart from the provider for the reason the assessment's is: the pages import a type and a
// hook rather than a component tree.

import { createContext, useContext } from 'react';
import type { Advisory } from './types';

export interface AdvisorValue {
  /** What the advisor last concluded, where it has run here. */
  readonly advisory?: Advisory;
  readonly loading: boolean;
  readonly error?: string;
  /**
   * Present where there is legitimately nothing to read: the advisor has not run here yet, or this
   * install has no advisor at all. Two different sentences, both written by the server, because one
   * means press the button and the other means this build cannot.
   */
  readonly reason?: string;
  /** Whether this reader has an advisory run in flight. */
  readonly advising: boolean;
  /** Why the run this reader started did not happen, including a run already in progress. */
  readonly adviseError?: string;
  readonly runAdvisor: () => void;
  readonly reload: () => void;
}

export const AdvisorContext = createContext<AdvisorValue | undefined>(undefined);

export function useAdvisor(): AdvisorValue {
  const value = useContext(AdvisorContext);
  if (value == null) throw new Error('useAdvisor must be used inside an AdvisorProvider.');
  return value;
}
