/**
 * Types for `guidance-citations.mjs`.
 *
 * Hand-written beside the module rather than inferred, for the reason the other `.d.mts` files here
 * exist: a `.mjs` imported from a `.ts` test resolves to `any`, and every assertion against it then
 * passes the type checker while telling the reader nothing.
 */

/** A cited URL, what cites it, and whether the citing rule makes an absolute claim. */
export interface Citation {
  url: string;
  where: string;
  absolute?: boolean;
}

export const GUIDANCE_DIR: string;
export const RULES_FILE: string;

export function guidanceCitations(dir?: string): Citation[];
export function rulesetCitations(file?: string): (Citation & { absolute: boolean })[];
