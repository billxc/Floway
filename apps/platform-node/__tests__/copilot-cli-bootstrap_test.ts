import { afterEach, describe, expect, it } from 'vitest';

import { ensureBuiltinCopilotCliUpstreams } from '../src/copilot-cli-bootstrap.ts';
import type { SqlRepo } from '@floway-dev/gateway';
import { initLocalCredentialProvider } from '@floway-dev/platform';

type StoredUpstream = Awaited<ReturnType<SqlRepo['upstreams']['list']>>[number];
type InsertUpstream = Parameters<SqlRepo['upstreams']['insertAtEndForModels']>[0];

const createFakeRepo = (initial: StoredUpstream[] = []): Pick<SqlRepo, 'upstreams'> & { rows: StoredUpstream[] } => {
  const rows = [...initial];
  return {
    rows,
    upstreams: {
      list: async () => [...rows],
      insertAtEndForModels: async (upstream: InsertUpstream) => {
        const stored: StoredUpstream = { ...upstream, sortOrder: rows.length, configVersion: 1 };
        rows.push(stored);
        return stored;
      },
    } as unknown as SqlRepo['upstreams'],
  };
};

describe('ensureBuiltinCopilotCliUpstreams', () => {
  afterEach(() => {
    initLocalCredentialProvider(null);
  });

  it('seeds missing local Copilot CLI accounts and preserves existing records across restarts', async () => {
    initLocalCredentialProvider({
      listAccounts: async () => [
        { host: 'github.com', login: 'octocat' },
        { host: 'github.com', login: 'dev_emu' },
      ],
      readCredential: async () => ({ token: 'ghu_test' }),
    });

    const repo = createFakeRepo();
    await expect(ensureBuiltinCopilotCliUpstreams(repo)).resolves.toBe(2);
    expect(repo.rows.map(row => ({ id: row.id, name: row.name, enabled: row.enabled, config: row.config }))).toEqual([
      {
        id: 'up_copilot_cli_octocat',
        name: 'Copilot CLI (octocat)',
        enabled: true,
        config: {
          githubHost: 'github.com',
          githubToken: '',
          credentialSource: 'copilot-cli',
          user: { login: 'octocat', avatar_url: '', name: null, id: 0 },
        },
      },
      {
        id: 'up_copilot_cli_dev_emu',
        name: 'Copilot CLI (dev_emu)',
        enabled: true,
        config: {
          githubHost: 'github.com',
          githubToken: '',
          credentialSource: 'copilot-cli',
          user: { login: 'dev_emu', avatar_url: '', name: null, id: 0 },
        },
      },
    ]);

    // Operator customizations survive subsequent startups.
    repo.rows[0] = { ...repo.rows[0]!, name: 'My CLI', enabled: false };
    await expect(ensureBuiltinCopilotCliUpstreams(repo)).resolves.toBe(0);
    expect(repo.rows).toHaveLength(2);
    expect(repo.rows[0]!.name).toBe('My CLI');
    expect(repo.rows[0]!.enabled).toBe(false);
  });
});
