import type { SqlRepo } from '@floway-dev/gateway';
import { listLocalCredentialAccounts, localCredentialProviderEnabled } from '@floway-dev/platform';

const DEFAULT_COPILOT_CLI_HUE = 215;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const builtinUpstreamId = (login: string): string =>
  `up_copilot_cli_${login.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`;

const existingCopilotCliLogin = (config: unknown): string | null => {
  if (!isRecord(config) || config.credentialSource !== 'copilot-cli') return null;
  if (!isRecord(config.user) || typeof config.user.login !== 'string') return null;
  return config.user.login.toLowerCase();
};

export const ensureBuiltinCopilotCliUpstreams = async (
  repo: Pick<SqlRepo, 'upstreams'>,
): Promise<number> => {
  if (!localCredentialProviderEnabled()) return 0;

  let accounts;
  try {
    accounts = await listLocalCredentialAccounts();
  } catch (error) {
    console.warn('[copilot-cli] Skipping built-in upstream sync:', error);
    return 0;
  }
  if (accounts.length === 0) return 0;

  const existing = await repo.upstreams.list();
  const knownLogins = new Set<string>();
  const knownIds = new Set<string>();
  for (const upstream of existing) {
    knownIds.add(upstream.id);
    if (upstream.kind !== 'copilot') continue;
    const login = existingCopilotCliLogin(upstream.config);
    if (login !== null) knownLogins.add(login);
  }

  let created = 0;
  for (const account of accounts) {
    const normalized = account.login.toLowerCase();
    const id = builtinUpstreamId(account.login);
    if (knownLogins.has(normalized) || knownIds.has(id)) continue;

    const now = new Date().toISOString();
    const saved = await repo.upstreams.insertAtEndForModels({
      id,
      kind: 'copilot',
      name: `Copilot CLI (${account.login})`,
      enabled: true,
      usageRefreshIntervalMinutes: 0,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
      config: {
        githubHost: account.host,
        githubToken: '',
        credentialSource: 'copilot-cli',
        user: {
          login: account.login,
          avatar_url: '',
          name: null,
          id: 0,
        },
      },
      state: null,
      modelsCache: null,
      flagOverrides: {},
      disabledPublicModelIds: [],
      proxyFallbackList: [],
      modelPrefix: null,
      hue: DEFAULT_COPILOT_CLI_HUE,
    });
    if (saved !== null) {
      knownLogins.add(normalized);
      knownIds.add(id);
      created += 1;
    }
  }
  return created;
};
