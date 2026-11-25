import { afterEach, describe, expect, it } from 'vitest';

import { copilotAuthedFetch } from '../src/auth.ts';
import { parseCopilotUpstreamConfig } from '../src/config.ts';
import { fetchCopilotUsage } from '../src/quota.ts';
import { initLocalCredentialProvider } from '@floway-dev/platform';
import type { Fetcher } from '@floway-dev/provider';

describe('provider-copilot local CLI credentials', () => {
  afterEach(() => {
    initLocalCredentialProvider(null);
  });

  it('accepts copilot-cli config without a stored githubToken', () => {
    const config = parseCopilotUpstreamConfig(
      {
        githubHost: 'github.com',
        githubToken: '',
        credentialSource: 'copilot-cli',
        user: { login: 'octocat', avatar_url: '', name: null, id: 0 },
      },
      (field, expected) => new Error(`${field}: ${expected}`),
    );
    expect(config).toEqual({
      githubHost: 'github.com',
      githubToken: '',
      credentialSource: 'copilot-cli',
      user: { login: 'octocat', avatar_url: '', name: null, id: 0 },
    });
  });

  it('authenticates directly with the local CLI token and headers', async () => {
    initLocalCredentialProvider({
      listAccounts: async () => [{ host: 'github.com', login: 'octocat' }],
      readCredential: async account => ({ token: `cli_tok_${account.login}` }),
    });

    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ url, headers: new Headers(init?.headers) });
      return new Response('{}', { status: 200 });
    };

    await copilotAuthedFetch(
      '/chat/completions',
      { method: 'POST', body: '{}' },
      { id: 'up_copilot_cli_octocat', githubHost: 'github.com', githubToken: '', githubLogin: 'octocat', credentialSource: 'copilot-cli' },
      {
        fetcher,
        headers: [['copilot-integration-id', ''], ['user-agent', 'claude-cli/1.0']],
        wrapUpstreamCall: dispatch => dispatch(),
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.githubcopilot.com/chat/completions');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer cli_tok_octocat');
    expect(calls[0]!.headers.get('copilot-integration-id')).toBe('copilot-cli');
    expect(calls[0]!.headers.get('user-agent')).toBe('Floway');

    await fetchCopilotUsage('github.com', '', fetcher, 'octocat');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('https://api.github.com/copilot_internal/user');
    expect(calls[1]!.headers.get('authorization')).toBe('token cli_tok_octocat');
  });
});
