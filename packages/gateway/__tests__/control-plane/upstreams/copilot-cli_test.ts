import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { copilotModels, MOCKED_FETCH_EGRESS, requestApp, requestAppWithWarmModels, setupAppTest, sseOpenAIResponsesResponse } from '../../test-utils/app.ts';
import { initLocalCredentialProvider, initRuntimeKind } from '@floway-dev/platform';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const account = { host: 'github.com', login: 'local-user' };
const user = { id: 123, login: account.login, name: 'Local User', avatar_url: 'https://example.com/avatar.png' };
const secret = 'synthetic-local-secret';
const record = { id: '', kind: 'copilot', config: { githubHost: 'github.com' }, state: null, proxy_fallback_list: MOCKED_FETCH_EGRESS };
const headers = (session: string) => ({ 'content-type': 'application/json', 'x-floway-session': session });
const readCredential = vi.fn(async () => ({ token: secret }));
const listAccounts = vi.fn(async () => [account]);
beforeEach(() => {
  initRuntimeKind('node'); readCredential.mockClear(); listAccounts.mockClear();
  initLocalCredentialProvider({ listAccounts, readCredential });
});
afterEach(() => {
  initLocalCredentialProvider(null); initRuntimeKind('node');
});

const upstream = (request: Request): Response => {
  const url = new URL(request.url);
  expect(request.headers.get('authorization')).toContain(secret);
  if (url.hostname === 'api.github.com' && url.pathname === '/user') return jsonResponse(user);
  if (url.hostname === 'api.githubcopilot.com' && url.pathname === '/models') return jsonResponse(copilotModels([{ id: 'gpt-6-luna', supported_endpoints: ['/responses'] }]));
  if (url.hostname === 'api.githubcopilot.com' && url.pathname === '/responses') return sseOpenAIResponsesResponse({
    id: 'resp_local', object: 'response', model: 'gpt-6-luna', status: 'completed', error: null, incomplete_details: null,
    output: [{ type: 'message', id: 'msg_local', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'local request succeeded', annotations: [] }] }],
  });
  throw new Error(`Unexpected test fetch ${url.pathname}`);
};

test('account discovery returns only metadata and is unavailable to non-admin users', async () => {
  const { adminSession, apiKey } = await setupAppTest();
  const response = await requestApp('/api/upstreams/copilot/local/accounts', { headers: headers(adminSession) });
  expect(await response.json()).toEqual({ enabled: true, accounts: [account] });
  expect(readCredential).not.toHaveBeenCalled();
  const nonAdmin = await requestApp('/api/upstreams/copilot/local/accounts', { headers: { 'x-api-key': apiKey.key } });
  expect(await nonAdmin.json()).toEqual({ enabled: false, accounts: [] });
  expect(listAccounts).toHaveBeenCalledOnce();
});

test('verify, save, reload, and request a new CLI upstream without importing credentials', async () => {
  const { adminSession, apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await withMockedFetch(upstream, async () => {
    const verified = await requestApp('/api/upstreams/copilot/local/connect', { method: 'POST', headers: headers(adminSession), body: JSON.stringify({ record, login: account.login }) });
    expect(verified.status).toBe(200);
    const body = await verified.json() as { patch: { config: Record<string, unknown>; state: unknown }; models: unknown[] };
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(body.patch.config).toMatchObject({ credentialSource: 'copilot-cli', githubToken: '', user });
    expect(body.models).toHaveLength(1);
    expect(await repo.upstreams.list()).toHaveLength(0);
    const saved = await requestApp('/api/upstreams', { method: 'POST', headers: headers(adminSession), body: JSON.stringify({ kind: 'copilot', name: 'Local Copilot', hue: 210, config: body.patch.config, state: body.patch.state, proxy_fallback_list: MOCKED_FETCH_EGRESS }) });
    expect(saved.status).toBe(201);
    const savedBody = await saved.json() as { id: string; config: Record<string, unknown> };
    expect(savedBody.config.credentialSource).toBe('copilot-cli');
    const stored = await repo.upstreams.getById(savedBody.id);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored?.config).toMatchObject({ credentialSource: 'copilot-cli', githubToken: '' });
    const reloaded = await requestApp(`/api/upstreams/${savedBody.id}`, { headers: headers(adminSession) });
    expect((await reloaded.json() as { config: Record<string, unknown> }).config.credentialSource).toBe('copilot-cli');
    const result = await requestAppWithWarmModels('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key }, body: JSON.stringify({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(result.status).toBe(200);
    expect((await result.json() as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe('local request succeeded');
  });
});

test('CLI source cannot persist supplied GitHub or Copilot tokens', async () => {
  const { adminSession } = await setupAppTest();
  for (const githubToken of [secret, '']) {
    const response = await requestApp('/api/upstreams', { method: 'POST', headers: headers(adminSession), body: JSON.stringify({ kind: 'copilot', name: 'Local', hue: 210, config: { githubHost: 'github.com', credentialSource: 'copilot-cli', githubToken, user }, state: { copilotToken: { token: secret, expiresAt: 4102444800, baseUrl: 'https://api.githubcopilot.com' } }, proxy_fallback_list: MOCKED_FETCH_EGRESS }) });
    expect(response.status).toBe(400);
  }
  expect(readCredential).not.toHaveBeenCalled();
});

test('disabled and Cloudflare runtimes never read local credentials', async () => {
  const { adminSession } = await setupAppTest();
  initRuntimeKind('cloudflare');
  const response = await requestApp('/api/upstreams/copilot/local/connect', { method: 'POST', headers: headers(adminSession), body: JSON.stringify({ record, login: account.login }) });
  expect(response.status).toBe(409);
  expect(readCredential).not.toHaveBeenCalled();
});
