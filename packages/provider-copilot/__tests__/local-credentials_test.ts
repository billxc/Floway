import { afterEach, expect, test, vi } from 'vitest';

import { copilotAuthedFetch } from '../src/auth.ts';
import { fetchCopilotUsage } from '../src/quota.ts';
import { initLocalCredentialProvider } from '@floway-dev/platform';
import { identityWrapUpstreamCall, type Fetcher } from '@floway-dev/provider';

const auth = { id: 'up_local', githubHost: 'github.com', githubLogin: 'tester', githubToken: '', credentialSource: 'copilot-cli' as const };
afterEach(() => initLocalCredentialProvider(null));

test.each(['/models', '/responses', '/chat/completions', '/v1/messages', '/v1/messages/count_tokens', '/embeddings'])('CLI credentials authenticate directly on %s without token exchange or persistence', async path => {
  const readCredential = vi.fn(async () => ({ token: 'local-token' }));
  initLocalCredentialProvider({ listAccounts: async () => [], readCredential });
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe(`https://api.githubcopilot.com${path}`);
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer local-token');
    expect(headers.get('copilot-integration-id')).toBe('copilot-cli');
    expect(headers.get('copilot-vision-request')).toBe('true');
    return new Response('{}');
  });
  const signal = new AbortController().signal;
  const response = await copilotAuthedFetch(path, { method: 'POST', body: '{}', signal }, auth, {
    fetcher, wrapUpstreamCall: identityWrapUpstreamCall,
    headers: [['authorization', 'untrusted-override'], ['copilot-integration-id', 'untrusted-integration'], ['copilot-vision-request', 'true']],
  });
  expect(response.status).toBe(200);
  expect(readCredential).toHaveBeenCalledWith({ host: 'github.com', login: 'tester' }, signal);
  expect(fetcher).toHaveBeenCalledOnce();
});

test('configured credential failure never falls back to a stored token', async () => {
  const failure = new Error('local account unavailable');
  initLocalCredentialProvider({ listAccounts: async () => [], readCredential: async () => { throw failure; } });
  const fetcher = vi.fn<Fetcher>();
  await expect(copilotAuthedFetch('/models', {}, auth, { fetcher, wrapUpstreamCall: identityWrapUpstreamCall })).rejects.toBe(failure);
  expect(fetcher).not.toHaveBeenCalled();
});

test('401 is preserved and later requests reread the CLI credential', async () => {
  const readCredential = vi.fn().mockResolvedValueOnce({ token: 'expired' }).mockResolvedValueOnce({ token: 'renewed-by-cli' });
  initLocalCredentialProvider({ listAccounts: async () => [], readCredential });
  const fetcher = vi.fn<Fetcher>(async (_url, init) => new Response('{}', { status: new Headers(init.headers).get('authorization') === 'Bearer expired' ? 401 : 200 }));
  const options = { fetcher, wrapUpstreamCall: identityWrapUpstreamCall };
  expect((await copilotAuthedFetch('/models', {}, auth, options)).status).toBe(401);
  expect((await copilotAuthedFetch('/models', {}, auth, options)).status).toBe(200);
  expect(readCredential).toHaveBeenCalledTimes(2);
});

test('quota queries read the bound CLI credential when cliLogin is supplied and use stored token otherwise', async () => {
  const readCredential = vi.fn(async () => ({ token: 'local-token' }));
  initLocalCredentialProvider({ listAccounts: async () => [], readCredential });
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe('https://api.github.com/copilot_internal/user');
    return new Response(new Headers(init.headers).get('authorization'));
  });
  const cliResp = await fetchCopilotUsage('github.com', '', fetcher, 'tester');
  expect(await cliResp.text()).toBe('token local-token');
  expect(readCredential).toHaveBeenCalledWith({ host: 'github.com', login: 'tester' }, undefined);

  const storedResp = await fetchCopilotUsage('github.com', 'stored-token', fetcher);
  expect(await storedResp.text()).toBe('token stored-token');
  expect(readCredential).toHaveBeenCalledOnce();
});
