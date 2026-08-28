/** One gate shape for every customer result and publication boundary. */
export type GateEligibilityStatePayload = 'eligible' | 'unknown' | 'unavailable' | 'unreadable' | 'incomplete';

export interface GateEligibilityReasonPayload {
  /** Stable machine reason, also used by mutation audit records. */
  readonly code: string;
  /** What the server actually read or failed to read. */
  readonly message: string;
  /** The next operator action; never an inference left to the browser. */
  readonly action: string;
}

export type GateEligibilityPayload =
  | { readonly eligible: true; readonly state: 'eligible' }
  | {
      readonly eligible: false;
      readonly state: Exclude<GateEligibilityStatePayload, 'eligible'>;
      readonly reason: GateEligibilityReasonPayload;
    };

export function eligible(): GateEligibilityPayload {
  return { eligible: true, state: 'eligible' };
}

export function ineligible(
  state: Exclude<GateEligibilityStatePayload, 'eligible'>,
  code: string,
  message: string,
  action: string
): Extract<GateEligibilityPayload, { readonly eligible: false }> {
  return { eligible: false, state, reason: { code, message, action } };
}
