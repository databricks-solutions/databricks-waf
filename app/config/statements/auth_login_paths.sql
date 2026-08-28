-- Signal: sql:security.auth_login_paths
-- Rows: 1
-- Benchmark: coverage
--
-- How people authenticated in the window: local username-and-password (`login`) versus
-- SSO (`samlLogin`) versus OAuth (`oidcTokenAuthorization`).
--
-- The account-plane configuration that would answer "are local users provisioned" is
-- unreadable (ADR 0016). The logins are not: each path is its own `action_name` on
-- `system.access.audit`. A workspace with password logins is therefore identifiable.
-- Zero of them does not prove no local account exists — only that none authenticated
-- that way in the retained window — so the control settles a failure rather than a
-- pass (same shape as every other measure that reads a log).
--
-- Three action names are decisive or named context, and every other authentication
-- action is counted and *named* rather than classified. The three alone were the whole
-- vocabulary, and on that reading an estate authenticating by some other path has no
-- events at all, so the control silently returns to being a question. Measured on labs
-- over 30 days (2026-08-10): 198,520 events under `tokenLogin`,
-- `workspaceInHouseOAuthClientAuthentication` and `accountInHouseOAuthClientAuthentication`,
-- against 388,871 under the three named ones — a third of the authentication traffic
-- invisible to a statement whose evidence called its own count "authentication events".
-- The two patterns are a way of *surfacing* names, not of deciding what they mean:
-- `other_auth_actions` returns them so the finding can say what it saw and claim nothing
-- about it. `aadBrowserLogin` and `jwtLogin`, the paths that prompted this, do not appear
-- on labs at all — it is an AWS account — so they are matched by the pattern rather than
-- listed from a vocabulary nobody here has measured.
--
-- Account-plane events carry `workspace_id = 0` and are admitted deliberately. The
-- live-workspace filter would drop them, and measured on labs it would have dropped 18
-- SAML logins and 2,398 OAuth ones — so a password login recorded at the account level
-- would have been filtered out and the failure would have read as unanswered. They are
-- counted separately because they belong to the account rather than to any workspace,
-- which is a thing the finding has to be able to say.
--
-- Measured on labs over 30 days (2026-08-10): no password logins, 57 SAML and 388,814
-- OAuth. The earlier reading of four password logins against a hundred and forty-four
-- SSO ones is not reproducible in the retained window and is not what this now says.
--
-- Feeds: SCP-01-01 (account setup and identity configuration).
SELECT
  -- The three named paths only. It stays what it was so that zero of it keeps meaning
  -- "none of the paths this reading names", which is the condition the control turns on;
  -- `other_auth_events` is deliberately not added into it.
  sum(CASE WHEN action_name IN ('login', 'samlLogin', 'oidcTokenAuthorization') THEN 1 ELSE 0 END) AS login_events,
  sum(CASE WHEN action_name = 'login' THEN 1 ELSE 0 END)                           AS password_logins,
  sum(CASE WHEN action_name = 'samlLogin' THEN 1 ELSE 0 END)                       AS saml_logins,
  sum(CASE WHEN action_name = 'oidcTokenAuthorization' THEN 1 ELSE 0 END)          AS oidc_logins,
  -- Authentication actions outside the three, counted and named. Neither the count nor
  -- the names say which are interactive, which are machine, or which imply a local
  -- credential; the resolver may report them and may not conclude from them.
  sum(CASE WHEN action_name NOT IN ('login', 'samlLogin', 'oidcTokenAuthorization') THEN 1 ELSE 0 END) AS other_auth_events,
  concat_ws(',', slice(array_sort(array_distinct(collect_list(
    CASE WHEN action_name NOT IN ('login', 'samlLogin', 'oidcTokenAuthorization') THEN action_name END
  ))), 1, 8))                                                                      AS other_auth_actions,
  -- Events recorded against the account rather than a workspace.
  sum(CASE WHEN workspace_id = 0 THEN 1 ELSE 0 END)                                AS account_plane_events,
  count(DISTINCT CASE
    WHEN action_name = 'login' THEN COALESCE(user_identity.email, user_identity.subject_name, 'unknown')
  END)                                                                             AS password_actors,
  max(CASE WHEN action_name = 'login' THEN event_time END)                         AS last_password_login
FROM system.access.audit
WHERE event_date >= current_date() - make_dt_interval(:lookback_days)
  AND (
    action_name IN ('login', 'samlLogin', 'oidcTokenAuthorization')
    OR lower(action_name) LIKE '%ogin%'
    OR lower(action_name) LIKE '%uthentication%'
  )
  -- Account-plane rows (`workspace_id = 0`) pass both scope filters, for the reason in the
  -- header: they are not in any workspace, including the one a scoped scan named, and
  -- dropping them turns a failure into an unanswered question.
  AND (:workspace_id = '' OR workspace_id = :workspace_id OR workspace_id = 0)
  AND (
    :live_workspace_ids = ''
    OR array_contains(split(:live_workspace_ids, ','), workspace_id)
    OR workspace_id = 0
  )
