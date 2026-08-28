// Security controls answered by workspace settings, tokens and serving endpoints.
//
// Fifteen of these read one flag each out of one call, so they are generated from the
// settings table rather than written out fifteen times. That is not only brevity: the
// interesting logic is identical in all fifteen — compare the value, and decide what an
// unset value means — and fifteen copies of it would be fifteen chances for one of them
// to treat an unset flag as a disabled one.
//
// The unset case is the whole difficulty. `workspace-conf` answers `null` for a setting
// the workspace has never touched, and the three ways to read that are: it is off, it is
// the platform's default, or it is unknowable from here. Which one applies depends on the
// setting, so each declares its own answer in `settings-keys.ts` along with the reason,
// and the reason is quoted in the finding whenever it decides the outcome. An estate is
// never told it failed a control on the strength of a guess about a default.

import { MAX_TOKEN_LIFETIME_KEY, SETTING_KEYS } from '../../collect/rest/settings-keys.js';
import type { ServingInventory, TokenInventory, WorkspaceSettings } from '../../collect/rest/shapes.js';
import type { SignalId } from '../../collect/signal.js';
import type { ControlResolver } from '../resolver.js';
import { evidenceFrom, detailFrom, fromSignal, fromSignals, notApplicable, threshold, unmeasured, valueOf } from './helpers.js';

const SETTINGS: SignalId = 'rest:workspace:preview.workspace-conf';
const TOKENS: SignalId = 'rest:workspace:token.list';
const SERVING: SignalId = 'rest:workspace:serving-endpoints';

/**
 * One resolver per flag, generated from the table.
 *
 * Per flag rather than one resolver claiming fifteen controls, because a resolver's
 * outcome is per control and these fifteen have nothing to do with each other beyond
 * arriving in the same response.
 */
const flagResolvers: readonly ControlResolver[] = SETTING_KEYS.map((setting) =>
  fromSignal<WorkspaceSettings>(SETTINGS, [setting.controlId], (settings, context) => {
    if (settings.unanswered.includes(setting.key)) {
      return unmeasured(
        `The workspace settings API did not return ${setting.key}. A key it does not recognise is usually one ` +
          'this cloud or workspace tier does not have, so the setting is reported as unmeasured rather than as ' +
          'switched off.'
      );
    }

    const value = settings.values.get(setting.key) ?? null;
    const expected = `${setting.label} is ${describeValue(setting.secure)}`;

    if (value == null) {
      // An unset value is the case that decides most of these on a real workspace, so
      // the reason it is being read one way rather than another is stated in the
      // finding rather than buried in the table.
      if (setting.whenAbsent === 'unknown') {
        // `attestation` rather than `unreadable`: the call succeeded and returned the workspace's
        // real state, which is that the setting has never been touched. The effective default it
        // falls back to is not published on any surface, so there is no grant and no scope that
        // would settle this — only somebody who knows how the workspace was created.
        return unmeasured(
          `${setting.label} has never been set in this workspace, and what that means cannot be determined ` +
            `from the setting alone. ${setting.absentReason}`,
          'attestation'
        );
      }

      return {
        outcome: 'fail',
        evidence: [
          evidenceFrom(
            context,
            SETTINGS,
            `${setting.label} has never been set in this workspace`,
            expected
          ),
        ],
        outcomeReason: setting.absentReason,
      };
    }

    const secure = value === setting.secure;
    return {
      outcome: secure ? 'pass' : 'fail',
      evidence: [
        evidenceFrom(context, SETTINGS, `${setting.label} is ${describeValue(value)}`, expected),
      ],
      ...(secure
        ? {}
        : {
            outcomeReason:
              `${setting.label} is explicitly ${describeValue(value)}. This is a deliberate setting ` +
              'rather than an unset default, so changing it is a decision someone already made and may need to revisit.',
          }),
    };
  })
);

/**
 * SCP-01-04: a maximum lifetime for new tokens.
 *
 * A number rather than a flag, and an absent one means no maximum — which is the finding.
 * The threshold is the catalogue's, so an estate with a stricter policy than ours can say so.
 */
const maxTokenLifetime = fromSignal<WorkspaceSettings>(SETTINGS, ['SCP-01-04'], (settings, context) => {
  const maxDays = threshold(context.spec, 'max_token_lifetime_days', 90);
  const expected = `New tokens expire within ${maxDays} days`;
  const raw = settings.values.get(MAX_TOKEN_LIFETIME_KEY) ?? null;

  if (raw == null) {
    return {
      outcome: 'fail',
      evidence: [evidenceFrom(context, SETTINGS, 'No maximum token lifetime is set', expected)],
      outcomeReason:
        'With no maximum lifetime configured, a token created today can be valid indefinitely. Unlike the ' +
        'view-ACL settings, this one has no permissive default to inherit: absent means unlimited.',
    };
  }

  const days = Number(raw);
  if (!Number.isFinite(days)) {
    return unmeasured(`The workspace reported a maximum token lifetime of "${raw}", which is not a number of days.`);
  }

  // Negative is the API's way of saying unlimited, and reads as a very short lifetime if
  // compared numerically without checking. That comparison would report the least
  // restrictive setting possible as a pass.
  if (days < 0) {
    return {
      outcome: 'fail',
      evidence: [evidenceFrom(context, SETTINGS, 'The maximum token lifetime is set to unlimited', expected)],
      outcomeReason: 'A negative maximum lifetime means tokens never expire, which is the setting this control exists to find.',
    };
  }

  const within = days <= maxDays;
  return {
    outcome: within ? 'pass' : 'partial',
    evidence: [evidenceFrom(context, SETTINGS, `The maximum token lifetime is ${days} days`, expected)],
    ...(within
      ? {}
      : {
          outcomeReason:
            `A maximum is set, which is the substantive part, but at ${days} days it is longer than the ` +
            `${maxDays} days expected. Partial rather than a failure because a bounded lifetime and an ` +
            'unbounded one are not the same risk.',
        }),
  };
});

/** SCP-01-03: tokens that never expire. */
const tokensWithoutExpiry = fromSignal<TokenInventory>(TOKENS, ['SCP-01-03'], (inventory, context) => {
  if (inventory.tokens.length === 0) {
    return notApplicable(
      'There are no personal access tokens in this workspace, so there are none whose lifetime could be unbounded.'
    );
  }

  const perpetual = inventory.tokens.filter((token) => token.expiresAt == null);
  const expected = 'Every personal access token has an expiry';

  return {
    outcome: perpetual.length === 0 ? 'pass' : 'fail',
    evidence: [
      evidenceFrom(
        context,
        TOKENS,
        `${perpetual.length} of ${inventory.tokens.length}${inventory.truncated ? '+' : ''} tokens never expire`,
        expected
      ),
      ...(perpetual.length > 0 ? [detailFrom(context, TOKENS, `Held by: ${owners(perpetual)}`)] : []),
    ],
    ...(perpetual.length > 0
      ? {
          outcomeReason:
            'A token with no expiry stays valid until someone revokes it, which means a departed employee\u2019s ' +
            'credential outlives their access. Setting a workspace maximum lifetime only binds new tokens, so ' +
            'these have to be revoked individually.',
        }
      : {}),
  };
});

/** SCP-04-01: tokens expiring soon, which is a housekeeping finding rather than a failure. */
const tokensExpiringSoon = fromSignal<TokenInventory>(TOKENS, ['SCP-04-01'], (inventory, context) => {
  const withinDays = threshold(context.spec, 'expiring_within_days', 30);
  const dated = inventory.tokens.filter((token) => token.expiresAt != null);

  if (dated.length === 0) {
    return notApplicable(
      inventory.tokens.length === 0
        ? 'There are no personal access tokens in this workspace.'
        : 'No token in this workspace has an expiry date, so none of them is approaching one. That absence is ' +
            'reported by the control on unbounded token lifetimes rather than here.'
    );
  }

  const horizon = Date.now() + withinDays * 86_400_000;
  const soon = dated.filter((token) => token.expiresAt!.getTime() <= horizon);
  const expected = `No token expires within the next ${withinDays} days without someone knowing`;

  return {
    // Partial rather than a failure: a token approaching expiry is correct behaviour that
    // needs attention, not a misconfiguration. Reporting it as a failure would mean an
    // estate doing exactly the right thing scores worse the closer it gets to rotating.
    outcome: soon.length === 0 ? 'pass' : 'partial',
    evidence: [
      evidenceFrom(context, TOKENS, `${soon.length} of ${dated.length} dated tokens expire within ${withinDays} days`, expected),
      ...(soon.length > 0 ? [detailFrom(context, TOKENS, `Expiring: ${owners(soon)}`)] : []),
    ],
    ...(soon.length > 0
      ? {
          outcomeReason:
            'These will stop working on their expiry date. Whatever uses them needs a replacement issued first, ' +
            'so this is a scheduling item rather than a security gap.',
        }
      : {}),
  };
});

/**
 * SCP-01-05: tokens outliving the workspace maximum.
 *
 * The only control here that needs two signals, and the comparison is the point: a
 * workspace can set a maximum today and still hold tokens issued under yesterday's
 * absence of one. The setting binds new tokens only.
 */
const tokensBeyondMaximum = fromSignals([SETTINGS, TOKENS], ['SCP-01-05'], (context) => {
  const settings = valueOf<WorkspaceSettings>(context, SETTINGS);
  const inventory = valueOf<TokenInventory>(context, TOKENS);

  const raw = settings.values.get(MAX_TOKEN_LIFETIME_KEY) ?? null;
  const maxDays = raw == null ? undefined : Number(raw);

  if (maxDays == null || !Number.isFinite(maxDays) || maxDays < 0) {
    return unmeasured(
      'This control compares existing tokens against the workspace maximum lifetime, and no usable maximum is ' +
        'set. Whether the existing tokens exceed a policy cannot be answered while there is no policy; that ' +
        'absence is the finding of the maximum-lifetime control instead.'
    );
  }

  const dated = inventory.tokens.filter((token) => token.expiresAt != null && token.createdAt != null);
  if (dated.length === 0) {
    return notApplicable(
      'No token in this workspace has both a creation and an expiry time, so no token\u2019s lifetime can be ' +
        'compared against the maximum.'
    );
  }

  const limit = maxDays * 86_400_000;
  const over = dated.filter((token) => token.expiresAt!.getTime() - token.createdAt!.getTime() > limit);
  const expected = `No token has a lifetime longer than the workspace maximum of ${maxDays} days`;

  return {
    outcome: over.length === 0 ? 'pass' : 'fail',
    evidence: [
      evidenceFrom(context, TOKENS, `${over.length} of ${dated.length} dated tokens were issued for longer than ${maxDays} days`, expected),
      ...(over.length > 0 ? [detailFrom(context, TOKENS, `Beyond the maximum: ${owners(over)}`)] : []),
    ],
    ...(over.length > 0
      ? {
          outcomeReason:
            `The maximum lifetime binds tokens issued after it was set, so these predate it. They keep their ` +
            'original lifetime until revoked, which means the policy is in force for new tokens and not yet true of the estate.',
        }
      : {}),
  };
});

/**
 * SCP-05-10: external models served through Databricks rather than called directly.
 *
 * Informational, and the direction is easy to get backwards: the finding is the *absence*
 * of an external-model endpoint, because routing third-party models through serving is
 * what keeps their API keys out of notebooks. An estate with no serving endpoints at all
 * is not failing this — it has nothing to route.
 */
const externalModelRouting = fromSignal<ServingInventory>(SERVING, ['SCP-05-10'], (inventory, context) => {
  if (inventory.endpoints.length === 0) {
    return notApplicable(
      'There are no model serving endpoints in this workspace, so there is no external-model routing to assess. ' +
        'This says nothing about whether third-party models are called directly from notebooks, which is not ' +
        'visible from here.'
    );
  }

  const external = inventory.endpoints.filter((endpoint) => endpoint.servedExternalModel);
  return {
    outcome: external.length > 0 ? 'pass' : 'partial',
    evidence: [
      evidenceFrom(
        context,
        SERVING,
        `${external.length} of ${inventory.endpoints.length} serving endpoints front an external model`,
        'Third-party models are reached through a serving endpoint, so their credentials live in one place'
      ),
    ],
    ...(external.length === 0
      ? {
          outcomeReason:
            'Endpoints exist but none fronts an external model. That is only a gap if third-party models are in ' +
            'use, which cannot be seen from the endpoint list, so it is reported as partial rather than as a failure.',
        }
      : {}),
  };
});

export const SECURITY_SETTINGS_RESOLVERS: readonly ControlResolver[] = [
  ...flagResolvers,
  maxTokenLifetime,
  tokensWithoutExpiry,
  tokensExpiringSoon,
  tokensBeyondMaximum,
  externalModelRouting,
];

/**
 * A flag's value as a phrase, so evidence reads as English rather than as a boolean.
 *
 * "The DBFS file browser is true" reads as a bug in the tool; "is enabled" reads as a
 * finding about the workspace.
 */
function describeValue(value: string): string {
  if (value === 'true') return 'enabled';
  if (value === 'false') return 'disabled';
  return `set to ${value}`;
}

/**
 * Who holds the tokens, capped, because a finding listing four hundred names is not read.
 *
 * These names are the app's only durable personal data — findings are stored, raw signal values are
 * not — and that is a decision rather than an oversight: the act this finding asks for is revoking
 * specific tokens, and an admin not told whose they are has to go and find out. ADR 0067, which also
 * says why the fall back through the comment stays.
 */
function owners(tokens: readonly { readonly createdBy: string | undefined; readonly comment: string | undefined }[]): string {
  const named = tokens
    .slice(0, 5)
    .map((token) => token.createdBy ?? token.comment ?? '(unattributed)')
    .join(', ');
  return tokens.length > 5 ? `${named}, and ${tokens.length - 5} more` : named;
}
