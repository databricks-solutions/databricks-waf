// A guided serving-asset declaration.
//
// Three separate identifiers are asked for because a qualified name cannot be safely split on dots.
// Tags are explicit selectors with an explicit level. Nothing in this form offers a schema-name
// convention, a grant, or a policy write: it records what the platform owner says and leaves the
// estate unchanged.

import { useState } from 'react';
import type { ServingDraft } from '../api/hooks';
import type { ServingDeclaration } from '../api/types';

interface AssetRow {
  readonly catalog: string;
  readonly schema: string;
  readonly table: string;
}

interface TagRow {
  readonly key: string;
  readonly values: string;
  readonly at: readonly ('catalog' | 'schema' | 'table')[];
}

interface PolicyRow {
  readonly classification: string;
  readonly requires: readonly ('column-mask' | 'row-filter' | 'abac-policy')[];
}

export interface FoundationDeclarationFormProps {
  readonly declaration: ServingDeclaration | null;
  readonly saving: boolean;
  readonly error?: string;
  readonly onSubmit: (draft: ServingDraft) => void;
  readonly onCancel: () => void;
}

export function FoundationDeclarationForm({
  declaration,
  saving,
  error,
  onSubmit,
  onCancel,
}: FoundationDeclarationFormProps) {
  const [assets, setAssets] = useState<readonly AssetRow[]>(
    declaration?.named.length ? declaration.named : [{ catalog: '', schema: '', table: '' }]
  );
  const [tags, setTags] = useState<readonly TagRow[]>(
    declaration?.tagged.map((tag) => ({
      key: tag.key,
      values: tag.values?.join(', ') ?? '',
      at: tag.at,
    })) ?? []
  );
  const [requiredMetadata, setRequiredMetadata] = useState<readonly ('description' | 'owner')[]>(
    (declaration?.requiredMetadata ?? []).filter(
      (field): field is 'description' | 'owner' => field === 'description' || field === 'owner'
    )
  );
  const [requiredTags, setRequiredTags] = useState(declaration?.requiredTagKeys.join(', ') ?? '');
  const [policy, setPolicy] = useState<readonly PolicyRow[]>(
    declaration?.policy.map((rule) => ({
      classification: rule.classification,
      requires: rule.requires.filter(
        (protection): protection is 'column-mask' | 'row-filter' | 'abac-policy' =>
          protection === 'column-mask' || protection === 'row-filter' || protection === 'abac-policy'
      ),
    })) ?? []
  );

  const completeAssets = assets.filter((asset) =>
    [asset.catalog, asset.schema, asset.table].every((part) => part.trim() !== '')
  );
  const partialAsset = assets.some((asset) => {
    const parts = [asset.catalog, asset.schema, asset.table].filter((part) => part.trim() !== '');
    return parts.length > 0 && parts.length < 3;
  });
  const completeTags = tags.filter((tag) => tag.key.trim() !== '' && tag.at.length > 0);
  const partialTag = tags.some((tag) => tag.key.trim() === '' || tag.at.length === 0);
  const partialPolicy = policy.some((rule) => rule.classification.trim() === '' || rule.requires.length === 0);
  const ready =
    (completeAssets.length > 0 || completeTags.length > 0) && !partialAsset && !partialTag && !partialPolicy;

  return (
    <form
      className="space-y-5 border-t border-wa-divider p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || saving) return;
        onSubmit({
          named: completeAssets.map((asset) => ({
            catalog: asset.catalog.trim(),
            schema: asset.schema.trim(),
            table: asset.table.trim(),
          })),
          tagged: completeTags.map((tag) => ({
            key: tag.key.trim(),
            ...(split(tag.values).length > 0 ? { values: split(tag.values) } : {}),
            at: tag.at,
          })),
          requiredTagKeys: split(requiredTags),
          requiredMetadata,
          policy: policy.map((rule) => ({ classification: rule.classification.trim(), requires: rule.requires })),
        });
      }}
    >
      <div className="space-y-2">
        <div>
          <h2 className="wa-body-compact font-medium text-wa-text">1. Select exact serving assets</h2>
          <p className="wa-caption">
            One identifier per field. Names are never treated as patterns or as evidence of “gold”.
          </p>
        </div>
        {assets.map((asset, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            {(['catalog', 'schema', 'table'] as const).map((part) => (
              <label key={part} className="flex min-w-0 flex-col gap-1">
                <span className="wa-label capitalize">{part}</span>
                <input
                  className="wa-field wa-body-compact min-w-0"
                  value={asset[part]}
                  onChange={(event) => setAssets(replace(assets, index, { ...asset, [part]: event.target.value }))}
                  autoComplete="off"
                />
              </label>
            ))}
            <button
              type="button"
              className="wa-button-secondary self-end"
              onClick={() => setAssets(remove(assets, index, { catalog: '', schema: '', table: '' }))}
              aria-label={`Remove exact asset ${String(index + 1)}`}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="wa-button-secondary"
          onClick={() => setAssets([...assets, { catalog: '', schema: '', table: '' }])}
        >
          Add exact asset
        </button>
      </div>

      <div className="space-y-2">
        <div>
          <h2 className="wa-body-compact font-medium text-wa-text">2. Or select assets by an existing tag</h2>
          <p className="wa-caption">
            Choose where the tag sits. A catalog tag deliberately selects every matching relation beneath it.
          </p>
        </div>
        {tags.map((tag, index) => (
          <div key={index} className="space-y-2 border-l-2 border-wa-divider pl-3">
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <label className="flex min-w-0 flex-col gap-1">
                <span className="wa-label">Tag key</span>
                <input
                  className="wa-field wa-body-compact"
                  value={tag.key}
                  onChange={(event) => setTags(replace(tags, index, { ...tag, key: event.target.value }))}
                  autoComplete="off"
                />
              </label>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="wa-label">Allowed values (optional)</span>
                <input
                  className="wa-field wa-body-compact"
                  value={tag.values}
                  onChange={(event) => setTags(replace(tags, index, { ...tag, values: event.target.value }))}
                  placeholder="certified, published"
                  autoComplete="off"
                />
              </label>
              <button
                type="button"
                className="wa-button-secondary self-end"
                onClick={() => setTags(tags.filter((_, at) => at !== index))}
                aria-label={`Remove tag selector ${String(index + 1)}`}
              >
                Remove
              </button>
            </div>
            <fieldset className="flex flex-wrap gap-3">
              <legend className="wa-label mb-1">Tag level</legend>
              {(['catalog', 'schema', 'table'] as const).map((level) => (
                <label key={level} className="wa-body-compact flex items-center gap-1.5 text-wa-text">
                  <input
                    type="checkbox"
                    checked={tag.at.includes(level)}
                    onChange={() => setTags(replace(tags, index, { ...tag, at: toggle(tag.at, level) }))}
                  />
                  {level}
                </label>
              ))}
            </fieldset>
          </div>
        ))}
        <button
          type="button"
          className="wa-button-secondary"
          onClick={() => setTags([...tags, { key: '', values: '', at: ['table'] }])}
        >
          Add tag selector
        </button>
      </div>

      <div className="space-y-2">
        <div>
          <h2 className="wa-body-compact font-medium text-wa-text">3. State what every selected asset must carry</h2>
          <p className="wa-caption">
            These are obligations in the declaration, not changes this app makes to the estate.
          </p>
        </div>
        <fieldset className="flex flex-wrap gap-3">
          <legend className="wa-label mb-1">Required metadata</legend>
          {(['description', 'owner'] as const).map((field) => (
            <label key={field} className="wa-body-compact flex items-center gap-1.5 text-wa-text">
              <input
                type="checkbox"
                checked={requiredMetadata.includes(field)}
                onChange={() => setRequiredMetadata(toggle(requiredMetadata, field))}
              />
              {field}
            </label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1">
          <span className="wa-label">Required tag keys (optional)</span>
          <input
            className="wa-field wa-body-compact"
            value={requiredTags}
            onChange={(event) => setRequiredTags(event.target.value)}
            placeholder="domain, data_owner"
            autoComplete="off"
          />
          <span className="wa-caption">Comma separated. Any value satisfies the declared key requirement.</span>
        </label>
      </div>

      <div className="space-y-2">
        <div>
          <h2 className="wa-body-compact font-medium text-wa-text">
            4. Describe classification obligations (optional)
          </h2>
          <p className="wa-caption">
            The app reads recorded protections. It never grants access or creates row filters, masks, or ABAC policies.
          </p>
        </div>
        {policy.map((rule, index) => (
          <div key={index} className="space-y-2 border-l-2 border-wa-divider pl-3">
            <div className="flex gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="wa-label">Classification</span>
                <input
                  className="wa-field wa-body-compact"
                  value={rule.classification}
                  onChange={(event) =>
                    setPolicy(replace(policy, index, { ...rule, classification: event.target.value }))
                  }
                  placeholder="restricted"
                  autoComplete="off"
                />
              </label>
              <button
                type="button"
                className="wa-button-secondary self-end"
                onClick={() => setPolicy(policy.filter((_, at) => at !== index))}
                aria-label={`Remove classification rule ${String(index + 1)}`}
              >
                Remove
              </button>
            </div>
            <fieldset className="flex flex-wrap gap-3">
              <legend className="wa-label mb-1">Must carry</legend>
              {(['column-mask', 'row-filter', 'abac-policy'] as const).map((protection) => (
                <label key={protection} className="wa-body-compact flex items-center gap-1.5 text-wa-text">
                  <input
                    type="checkbox"
                    checked={rule.requires.includes(protection)}
                    onChange={() =>
                      setPolicy(replace(policy, index, { ...rule, requires: toggle(rule.requires, protection) }))
                    }
                  />
                  {protection}
                </label>
              ))}
            </fieldset>
          </div>
        ))}
        <button
          type="button"
          className="wa-button-secondary"
          onClick={() => setPolicy([...policy, { classification: '', requires: [] }])}
        >
          Add classification rule
        </button>
      </div>

      {error != null && (
        <p className="wa-body-compact text-wa-danger" role="alert">
          {error}
        </p>
      )}
      {(partialAsset || partialTag || partialPolicy) && (
        <p className="wa-body-compact text-wa-warning" role="status">
          Finish or remove each partly completed row before declaring.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-wa-divider pt-3">
        <p className="wa-caption">
          {declaration == null
            ? 'Creates version 1 in this assessment and records who declared it.'
            : `Creates version ${String(declaration.version + 1)}; version ${String(declaration.version)} remains in history.`}
        </p>
        <span className="flex gap-2">
          <button type="button" className="wa-button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="wa-button-primary" disabled={!ready || saving}>
            {saving ? 'Declaring…' : declaration == null ? 'Declare serving assets' : 'Declare new version'}
          </button>
        </span>
      </div>
    </form>
  );
}

function split(value: string): readonly string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function replace<T>(values: readonly T[], index: number, value: T): readonly T[] {
  return values.map((current, at) => (at === index ? value : current));
}

function remove<T>(values: readonly T[], index: number, fallback: T): readonly T[] {
  const next = values.filter((_, at) => at !== index);
  return next.length === 0 ? [fallback] : next;
}

function toggle<T extends string>(values: readonly T[], value: T): readonly T[] {
  return values.includes(value) ? values.filter((held) => held !== value) : [...values, value];
}
