import { afterEach, expect, test, vi } from 'vitest';

import { copilotAuthedFetch } from '../src/auth.ts';
import { fetchCopilotUsage } from '../src/quota.ts';
import { initLocalCredentialReader } from '@floway-dev/platform';
import { identityWrapUpstreamCall, type Fetcher } from '@floway-dev/provider';

const auth = { id: 'up_local', githubHost: 'github.com', githubLogin: 'tester', githubToken: 'stored-token-must-not-be-used' };
afterEach(() => initLocalCredentialReader(null));

test.each(['/models', '/responses', '/chat/completions', '/v1/messages', '/v1/messages/count_tokens', '/embeddings'])('CLI credentials authenticate directly on %s without token exchange or persistence', async path => {
  const reader = vi.fn(async () => ({ token: 'local-token' }));
  initLocalCredentialReader(reader);
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
  expect(reader).toHaveBeenCalledWith({ upstreamId: 'up_local', host: 'github.com', login: 'tester' }, signal);
  expect(fetcher).toHaveBeenCalledOnce();
});

test('configured credential failure never falls back to the stored token', async () => {
  const failure = new Error('local account unavailable');
  initLocalCredentialReader(async () => { throw failure; });
  const fetcher = vi.fn<Fetcher>();
  await expect(copilotAuthedFetch('/models', {}, auth, { fetcher, wrapUpstreamCall: identityWrapUpstreamCall })).rejects.toBe(failure);
  expect(fetcher).not.toHaveBeenCalled();
});

test('401 is preserved and later requests reread the CLI credential', async () => {
  const reader = vi.fn().mockResolvedValueOnce({ token: 'expired' }).mockResolvedValueOnce({ token: 'renewed-by-cli' });
  initLocalCredentialReader(reader);
  const fetcher = vi.fn<Fetcher>(async (_url, init) => new Response('{}', { status: new Headers(init.headers).get('authorization') === 'Bearer expired' ? 401 : 200 }));
  const options = { fetcher, wrapUpstreamCall: identityWrapUpstreamCall };
  expect((await copilotAuthedFetch('/models', {}, auth, options)).status).toBe(401);
  expect((await copilotAuthedFetch('/models', {}, auth, options)).status).toBe(200);
  expect(reader).toHaveBeenCalledTimes(2);
});

test('quota queries read the same bound CLI credential', async () => {
  const reader = vi.fn(async () => ({ token: 'local-token' }));
  initLocalCredentialReader(reader);
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe('https://api.github.com/copilot_internal/user');
    expect(new Headers(init.headers).get('authorization')).toBe('token local-token');
    return new Response('{}');
  });
  const identity = { upstreamId: 'up_local', host: 'github.com', login: 'tester' };
  await fetchCopilotUsage('github.com', auth.githubToken, fetcher, identity);
  expect(reader).toHaveBeenCalledWith(identity, undefined);
});

test('quota queries retain stored-token authentication when there is no local binding', async () => {
  initLocalCredentialReader(async () => null);
  const fetcher = vi.fn<Fetcher>(async (_url, init) => {
    expect(new Headers(init.headers).get('authorization')).toBe('token stored-token');
    return new Response('{}');
  });
  await fetchCopilotUsage('github.com', 'stored-token', fetcher, { upstreamId: 'up_remote', host: 'github.com', login: 'remote' });
  expect(fetcher).toHaveBeenCalledOnce();
});
