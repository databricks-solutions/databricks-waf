/** Types for measure-action-provenance.mjs, which is JavaScript so it can run from the CLI unbuilt. */

export type TypeRef =
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'array'; readonly of: TypeRef }
  | { readonly kind: 'primitive'; readonly name: string }
  | { readonly kind: 'enumeration'; readonly members: readonly string[] }
  | { readonly kind: 'other'; readonly text: string };

export interface Property {
  readonly name: string;
  readonly optional: boolean;
  readonly type: TypeRef;
}

export interface Shape {
  readonly name: string;
  readonly properties: readonly Property[];
}

export interface Level {
  readonly property: string;
  readonly type: string;
  readonly repeated: boolean;
}

export interface Chain {
  readonly advisor: string;
  readonly finding: string;
  readonly levels: readonly Level[];
  readonly identity: { readonly property: string; readonly closed: boolean };
  readonly version: readonly { readonly property: string; readonly at: string }[];
  readonly resource: readonly { readonly property: string; readonly at: string }[];
  readonly baseline: readonly { readonly property: string; readonly through: string | null }[];
  readonly prose: readonly string[];
}

export interface Census {
  readonly measuredAt?: string;
  readonly source: string;
  readonly run: string;
  readonly declared: { readonly identity: readonly string[]; readonly narrative: readonly string[] };
  readonly chains: readonly Chain[];
  readonly totals: {
    readonly advisors: number;
    readonly withIdentityOnTheFinding: number;
    readonly withVersionAnywhere: number;
    readonly withVersionOnTheFinding: number;
    readonly withResourceAnywhere: number;
    readonly withResourceOnTheFinding: number;
    readonly withNumericBaseline: number;
    readonly withAllFourOnTheFinding: number;
  };
}

export const RECORDING: string;
export const DOC: string;
export const RUN: string;
export const IDENTITY: readonly string[];
export const NARRATIVE: readonly string[];

export function shapesFrom(source: string): Map<string, Shape>;

export function chainsFrom(shapes: Map<string, Shape>): readonly Chain[];

export function measure(): Census;
