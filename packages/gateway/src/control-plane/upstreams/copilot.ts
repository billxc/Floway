import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { upstreamErrorMessage as errorMessage } from './shared.ts';
import { fullUpstreamActionError } from '../../access-control/upstream-edit.ts';
import { userFromContext, type AuthedContext } from '../../middleware/auth.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { copilotCliConnectBody, copilotOAuthDeviceLoginPollBody, copilotOAuthDeviceLoginStartBody, copilotQuotaBody } from '../schemas.ts';
import { isRecord } from '../shared/field-validators.ts';
import { saveUpstream } from '../shared/save-upstreams.ts';
import { getRuntimeKind, listLocalCredentialAccounts, localCredentialProviderEnabled, readLocalCredential } from '@floway-dev/platform';
import type { Fetcher, UpstreamRecord } from '@floway-dev/provider';
import {
  assertCopilotUpstreamRecord,
  clearInProcessCopilotTokenCache,
  emptyCopilotUpstreamState,
  exchangeCopilotToken,
  fetchCopilotModels,
  fetchCopilotUsage,
  projectCopilotSeat,
  putCopilotSeat,
  type CopilotSeatEntry,
  fetchGitHubUser,
  normalizeGitHubHost,
  parseCopilotUpstreamConfig,
  pollGitHubDeviceFlow,
  projectCopilotUsageResponse,
  putCopilotQuota,
  readCopilotUpstreamState,
  startGitHubDeviceFlow,
  type CopilotTokenEntry,
  type CopilotUpstreamConfig,
  type CopilotUpstreamState,
  type CopilotUpstreamUser,
  type CopilotUsageResponse,
} from '@floway-dev/provider-copilot';

const parseCopilotDraftConfig = (config: unknown): { config: Record<string, unknown>; githubHost: string } => {
  if (!isRecord(config) || typeof config.githubHost !== 'string') {
    throw new Error('Copilot config must include a GitHub host');
  }
  return { config, githubHost: normalizeGitHubHost(config.githubHost) };
};

export const copilotOAuthDeviceLoginStart = async (c: CtxWithJson<typeof copilotOAuthDeviceLoginStartBody>) => {
  const { record } = c.req.valid('json');
  const accessError = await fullUpstreamActionError(userFromContext(c), record.id);
  if (accessError) return c.json({ error: accessError.error }, accessError.status);
  if (record.kind !== 'copilot') return c.json({ error: 'Upstream is not a Copilot upstream' }, 400);

  let githubHost: string;
  let fetcher: Fetcher;
  try {
    ({ githubHost } = parseCopilotDraftConfig(record.config));
    fetcher = await resolveControlPlaneFetcher({ override: record.proxy_fallback_list, runtimeLocation: getRuntimeLocation(c.req.raw) });
  } catch (e: unknown) {
    return c.json({ error: errorMessage(e) }, 400);
  }

  try {
    const result = await startGitHubDeviceFlow(githubHost, fetcher);
    if (!result.ok) return c.json({ error: result.error }, 502);
    return c.json(result.data);
  } catch (e: unknown) {
    const msg = errorMessage(e);
    return c.json({ error: msg }, 502);
  }
};

// Unified device-login poll under the record-body action contract. The
// GitHub device flow is inherently stateless; this handler exchanges the
// device_code for a GitHub PAT + user info + Copilot access token, and
// returns them as a patch to merge into the caller's draft record. When
// the caller supplies a persisted `record.id`, the same patch is
// simultaneously applied to the stored record so the live data plane
// picks up the fresh credential immediately.
export const copilotOAuthDeviceLoginPoll = async (c: CtxWithJson<typeof copilotOAuthDeviceLoginPollBody>) => {
  const { record, deviceCode } = c.req.valid('json');
  const accessError = await fullUpstreamActionError(userFromContext(c), record.id);
  if (accessError) return c.json({ status: 'error' as const, error: accessError.error }, accessError.status);
  if (record.kind !== 'copilot') return c.json({ status: 'error' as const, error: 'Upstream is not a Copilot upstream' }, 400);

  // Config-validation errors (e.g. unknown proxy id in the override) surface
  // as 400 — they belong to the caller, not to the upstream.
  let fetcher: Fetcher;
  let githubHost: string;
  try {
    ({ githubHost } = parseCopilotDraftConfig(record.config));
    fetcher = await resolveControlPlaneFetcher({ override: record.proxy_fallback_list, runtimeLocation: getRuntimeLocation(c.req.raw) });
  } catch (err) {
    return c.json({ status: 'error' as const, error: errorMessage(err) }, 400);
  }

  // Upstream-facing calls (GitHub device poll + user lookup + Copilot token
  // exchange) can legitimately 502 the caller when GitHub / Copilot is
  // unhealthy. DB ops below run OUTSIDE this catch so that a repo `.save()`
  // or scheduler failure surfaces as a 500 with a stack, not as a
  // misleading "upstream error" 502.
  type UpstreamCred = {
    user: CopilotUpstreamUser;
    tokenEntry: CopilotTokenEntry;
    accessToken: string;
    seat: CopilotSeatEntry | null;
  };
  let cred: UpstreamCred;
  try {
    const data = await pollGitHubDeviceFlow(githubHost, deviceCode, fetcher);

    if (data.error === 'authorization_pending') return c.json({ status: 'pending' as const });
    if (data.error === 'slow_down') return c.json({ status: 'slow_down' as const });
    if (data.error) return c.json({ status: 'error' as const, error: data.error_description ?? data.error }, 400);
    if (!data.access_token) return c.json({ status: 'error' as const, error: 'Unknown response' }, 500);

    // Validates the PAT + seeds a fresh Copilot access token so the data
    // plane and dashboard `endpoints.api` calls work immediately without
    // a follow-up exchange round trip.
    const user = await fetchGitHubUser(githubHost, data.access_token, fetcher);
    const tokenEntry = await exchangeCopilotToken(githubHost, data.access_token, fetcher);
    cred = { user, tokenEntry, accessToken: data.access_token, seat: null };
  } catch (e: unknown) {
    return c.json({ status: 'error' as const, error: errorMessage(e) }, 502);
  }

  // Read outside the block above: the credential is already valid, so a seat
  // this call could not read costs the row its plan name until the next
  // refresh and must not cost the operator the import.
  try {
    const resp = await fetchCopilotUsage(githubHost, cred.accessToken, fetcher);
    if (resp.ok) {
      const seat = projectCopilotSeat((await resp.json()) as CopilotUsageResponse, new Date());
      if (seat !== null) cred = { ...cred, seat: { fetchedAt: Date.now(), data: seat } };
    }
  } catch (err: unknown) {
    console.warn('Failed to read the Copilot seat during import:', err);
  }

  const configPatch: CopilotUpstreamConfig = { githubHost, githubToken: cred.accessToken, user: cred.user };

  // Return the fully-merged state slot instead of a partial `{ copilotToken }`
  // patch. Frontend `applyPatch` does whole-slot replacement on state, so a
  // partial slot would clobber any sibling field (e.g. draft.state.knownModels
  // hydrated by an earlier fetch). Edit state seeds the merge from the stored
  // record only while the GitHub identity is unchanged. Identity changes and
  // creates start from an empty slot, so the reply is uniformly a full slot
  // regardless of caller path.
  let nextState: CopilotUpstreamState;
  if (record.id !== '') {
    const dbRecord = await getRepo().upstreams.getById(record.id);
    if (!dbRecord) return c.json({ status: 'error' as const, error: 'Upstream not found' }, 404);
    if (dbRecord.kind !== 'copilot') return c.json({ status: 'error' as const, error: 'Upstream is not a Copilot upstream' }, 400);
    const previous = assertCopilotUpstreamRecord(dbRecord);
    const sameIdentity = previous.config.githubHost === githubHost && previous.config.user.id === cred.user.id;
    const prevState = sameIdentity ? readCopilotUpstreamState(dbRecord.state) : emptyCopilotUpstreamState();
    nextState = { ...prevState, copilotToken: cred.tokenEntry, seat: cred.seat ?? prevState.seat };
    const previousUpdatedAt = Date.parse(dbRecord.updatedAt);
    if (!Number.isFinite(previousUpdatedAt)) throw new Error(`Copilot upstream ${record.id} has an invalid updatedAt timestamp`);
    const updatedAt = new Date(Math.max(Date.now(), previousUpdatedAt + 1)).toISOString();
    const next: UpstreamRecord = { ...dbRecord, config: configPatch, state: nextState, updatedAt };
    clearInProcessCopilotTokenCache();
    await saveUpstream({ previous: dbRecord, next });
  } else {
    nextState = { ...emptyCopilotUpstreamState(), copilotToken: cred.tokenEntry, seat: cred.seat };
  }

  return c.json({
    status: 'complete' as const,
    user: cred.user,
    patch: {
      config: configPatch,
      state: nextState,
    },
  });
};

// Refresh GitHub Copilot quota for the draft's github token. The data plane
// already keeps `state.quotaSnapshot` current from the `x-quota-snapshot-*`
// headers on every upstream response, so this is the explicit path: it seeds an
// upstream that has not served a request yet (including one still in create
// state, where there is no row to persist to), and lets an operator force a
// read without generating traffic. The projected snapshot is written into the
// same slot the passive path fills, so both sources render identically and the
// newer observation always wins. Replying with `null` means the upstream
// reported no buckets at all; the dashboard then keeps showing the stored
// snapshot rather than blanking the card.
export const copilotQuota = async (c: CtxWithJson<typeof copilotQuotaBody>) => {
  const { record } = c.req.valid('json');
  const accessError = await fullUpstreamActionError(userFromContext(c), record.id);
  if (accessError) return c.json({ error: accessError.error }, accessError.status);
  if (record.kind !== 'copilot') return c.json({ error: 'Upstream is not a Copilot upstream' }, 400);

  let githubHost: string;
  let githubToken: string;
  let githubLogin: string;
  let credentialSource: CopilotUpstreamConfig['credentialSource'];
  let fetcher: Fetcher;
  try {
    const parsed = parseCopilotDraftConfig(record.config);
    githubHost = parsed.githubHost;
    const { config } = parsed;
    credentialSource = config.credentialSource === 'copilot-cli' ? 'copilot-cli' : undefined;
    if (credentialSource === 'copilot-cli') {
      const error = localCopilotAccessError(c);
      if (error) return c.json({ error: error.error }, error.status);
    } else if (typeof config.githubToken !== 'string' || config.githubToken === '') {
      return c.json({ error: 'Copilot upstream has no GitHub token' }, 400);
    }
    githubToken = typeof config.githubToken === 'string' ? config.githubToken : '';
    githubLogin = isRecord(config.user) && typeof config.user.login === 'string' ? config.user.login : '';
    fetcher = await resolveControlPlaneFetcher({ override: record.proxy_fallback_list, runtimeLocation: getRuntimeLocation(c.req.raw) });
  } catch (e: unknown) {
    return c.json({ error: errorMessage(e) }, 400);
  }

  try {
    const resp = await fetchCopilotUsage(githubHost, githubToken, fetcher, credentialSource === 'copilot-cli' ? githubLogin : undefined);

    if (!resp.ok) {
      const text = await resp.text();
      const status = resp.status === 401 || resp.status === 403 ? 502 : resp.status;
      return c.json({ error: `GitHub API error: ${resp.status} ${text}` }, status as 400 | 404 | 500 | 502);
    }

    const body = (await resp.json()) as CopilotUsageResponse;
    const now = new Date();
    const snapshot = projectCopilotUsageResponse(body, now);
    const seat = projectCopilotSeat(body, now);
    // The plan rides on the same body as the quota, so the operator's refresh
    // stores both. It is the only path that reads this endpoint after import,
    // and a storage failure here must not fail the reading it was asked for.
    if (seat !== null && record.id !== '') {
      await putCopilotSeat(record.id, seat).catch((err: unknown) => {
        console.warn(`Failed to persist Copilot seat for ${record.id}:`, err);
      });
    }
    // A body that reports no buckets is "nothing observed", so it neither
    // persists nor replaces what the dashboard is already showing — the
    // caller falls back to the stored snapshot. The reading otherwise merges
    // into whatever state wins the row, and the catch is here only so a
    // storage failure does not fail the operator's request.
    if (snapshot !== null && record.id !== '') {
      await putCopilotQuota(record.id, snapshot).catch((err: unknown) => {
        console.warn(`Failed to persist Copilot quota snapshot for ${record.id}:`, err);
      });
    }
    return c.json(snapshot);
  } catch (e: unknown) {
    return c.json({ error: errorMessage(e) }, 502);
  }
};

export const localCopilotAccessError = (c: AuthedContext): { error: string; status: 403 | 409 } | null => {
  if (!userFromContext(c).isAdmin) return { error: 'Admin privileges required for local Copilot credentials', status: 403 };
  if (getRuntimeKind() !== 'node' || !localCredentialProviderEnabled()) return { error: 'Local Copilot CLI credentials are not enabled on this Node instance', status: 409 };
  return null;
};

export const copilotCliAccounts = async (c: AuthedContext) => {
  if (!userFromContext(c).isAdmin || getRuntimeKind() !== 'node' || !localCredentialProviderEnabled()) {
    return c.json({ enabled: false, accounts: [] });
  }
  try {
    const accounts = await listLocalCredentialAccounts(c.req.raw.signal);
    return c.json({ enabled: true, accounts: accounts.map(account => ({ host: account.host, login: account.login })) });
  } catch {
    return c.json({ error: 'Unable to read the local Copilot CLI account list' }, 502);
  }
};

export const copilotCliConnect = async (c: CtxWithJson<typeof copilotCliConnectBody>) => {
  const accessError = localCopilotAccessError(c);
  if (accessError) return c.json({ error: accessError.error }, accessError.status);
  const { record, login } = c.req.valid('json');
  const editError = await fullUpstreamActionError(userFromContext(c), record.id);
  if (editError) return c.json({ error: editError.error }, editError.status);
  if (record.kind !== 'copilot') return c.json({ error: 'Upstream is not a Copilot upstream' }, 400);
  const signal = c.req.raw.signal;
  try {
    const fetcher = await resolveControlPlaneFetcher({ override: record.proxy_fallback_list, runtimeLocation: getRuntimeLocation(c.req.raw) });
    const accounts = await listLocalCredentialAccounts(signal);
    const account = accounts.find(value => value.host === 'github.com' && value.login.toLowerCase() === login.toLowerCase());
    if (account === undefined) throw new Error('Selected Copilot CLI account is not signed in locally');
    const credential = await readLocalCredential(account, signal);
    const user = await fetchGitHubUser('github.com', credential.token, (url, init) => fetcher(url, { ...init, redirect: 'error', signal }));
    const config = parseCopilotUpstreamConfig({ githubHost: 'github.com', githubToken: '', credentialSource: 'copilot-cli', user }, () => new Error('GitHub returned an invalid account identity'));
    if (config.user.login.toLowerCase() !== account.login.toLowerCase()) throw new Error('Copilot CLI credential belongs to a different GitHub account');
    const catalog = await fetchCopilotModels({ id: record.id || 'copilot-cli-draft', githubHost: 'github.com', githubToken: '', githubLogin: config.user.login, credentialSource: 'copilot-cli' }, (url, init) => fetcher(url, { ...init, signal }));
    return c.json({
      patch: { config, state: emptyCopilotUpstreamState() },
      models: catalog.data.map(model => ({ id: model.id, name: model.display_name ?? model.name ?? model.id })),
    });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 502);
  }
};
