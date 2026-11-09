import { test } from 'vitest';

import { tokenCountsFromUsage } from '../../../src/repo/usage-metrics.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, copilotModels, flushAsyncWork, MOCKED_FETCH_EGRESS, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { jsonResponse, withMockedFetch, assertEquals, assertExists } from '@floway-dev/test-utils';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/wEAAAAASUVORK5CYII=';

test('/v1/images/generations rejects malformed JSON body with 400', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestAppWithWarmModels('/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: 'not json',
  });
  assertEquals(response.status, 400);
});

test('/v1/images/generations rejects body without model with 400', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestAppWithWarmModels('/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ prompt: 'hi' }),
  });
  assertEquals(response.status, 400);
});

test('/v1/images/generations 404s when no upstream provides the model', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'no-such-model', prompt: 'hi' }),
      });
      assertEquals(response.status, 404);
    },
  );
});

test('/v1/images/edits rejects malformed JSON with 400', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestAppWithWarmModels('/v1/images/edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: 'not json',
  });
  assertEquals(response.status, 400);
});

test('/v1/images/edits rejects JSON without a model with 400', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestAppWithWarmModels('/v1/images/edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ prompt: 'hi', images: [{ file_id: 'file-image' }] }),
  });
  assertEquals(response.status, 400);
});

test('/v1/images/edits rejects multipart body without model field with 400', async () => {
  const { apiKey } = await setupAppTest();
  const form = new FormData();
  form.append('prompt', 'hi');
  const response = await requestAppWithWarmModels('/v1/images/edits', {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key },
    body: form,
  });
  assertEquals(response.status, 400);
});

test('/v1/images/generations rejects model on custom upstream without /images/generations capability', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  // Chat-only custom upstream. Its /models response advertises gpt-4o
  // (which the id heuristic leaves as the chat fallback), so the resolver
  // returns `sawModel=true` with zero candidates after the kind filter
  // — distinguishing wrong-kind from unknown-id at the resolver layer.
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_chat_only',
    name: 'Chat Only Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://chat.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-chat',
      endpoints: { openaiChatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'chat.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'gpt-4o', prompt: 'hi' }),
      });
      assertEquals(response.status, 400);
      const body = await response.json() as { error: { message: string } };
      assertEquals(body.error.message, 'Model gpt-4o does not support the /images/generations endpoint.');
    },
  );
});

test.each(['generations', 'edits'])('/v1/images/%s forwards through Copilot and records image usage', async operation => {
  const { apiKey, repo } = await setupAppTest();
  clearInProcessCopilotTokenCache();
  const model = 'gpt-image-2.5-flare';
  const path = `/v1/images/${operation}`;
  const output = {
    data: [{ b64_json: PNG_B64 }],
    usage: { input_tokens: 7, input_tokens_details: { text_tokens: 5, image_tokens: 2 }, output_tokens: 11, output_tokens_details: { text_tokens: 0, image_tokens: 11 } },
  };
  let calls = 0;
  await withMockedFetch(
    async request => {
      const { pathname } = new URL(request.url);
      if (pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (pathname === '/models') {
        return jsonResponse({ object: 'list', data: [{ id: model, name: 'GPT Image 2.5 Flare', capabilities: { type: 'image' }, supported_endpoints: ['/v1/images/generations', '/v1/images/edits'] }] });
      }
      if (pathname === path) {
        calls++;
        assertEquals(request.headers.get('authorization'), 'Bearer copilot-access-token');
        if (operation === 'generations') {
          assertEquals(await request.json(), { model, prompt: 'a blue bird', quality: 'future-quality' });
        } else {
          const form = await request.formData();
          assertEquals(form.get('model'), model);
          assertEquals(form.get('prompt'), 'a blue bird');
          assertEquals(form.get('quality'), 'future-quality');
          assertEquals(await (form.get('image') as File).text(), 'image-bytes');
          assertEquals(await (form.get('mask') as File).text(), 'mask-bytes');
        }
        return new Response(JSON.stringify(output), { status: 201, headers: { 'content-type': 'application/json', 'x-request-id': 'copilot-image' } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const headers = { 'x-api-key': apiKey.key };
      let body: string | FormData;
      if (operation === 'generations') {
        body = JSON.stringify({ model, prompt: 'a blue bird', quality: 'future-quality' });
      } else {
        body = new FormData();
        body.set('model', model);
        body.set('prompt', 'a blue bird');
        body.set('quality', 'future-quality');
        body.set('image', new File(['image-bytes'], 'image.png', { type: 'image/png' }));
        body.set('mask', new File(['mask-bytes'], 'mask.png', { type: 'image/png' }));
      }
      const response = await requestAppWithWarmModels(path, {
        method: 'POST', headers: { ...headers, ...(operation === 'generations' ? { 'content-type': 'application/json' } : {}) }, body,
      });
      assertEquals(response.status, 201);
      assertEquals(response.headers.get('x-request-id'), 'copilot-image');
      assertEquals(await response.json(), output);
      await flushAsyncWork();
    },
  );
  assertEquals(calls, 1);
  const usageRows = (await repo.usage.listAll()).filter(row => row.model === model);
  assertEquals(usageRows.length, 1);
  assertEquals(tokenCountsFromUsage(usageRows[0]), { input: 5, input_image: 2, output_image: 11 });
});

test('/v1/images/generations forwards a JSON request through a custom upstream and records usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  clearInProcessCopilotTokenCache();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_images',
    name: 'Custom Image Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://images.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-images',
      endpoints: {},
    },
  }));

  let forwarded: Record<string, unknown> | undefined;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.hostname === 'images.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ data: [{ id: 'gpt-image-2' }] });
      }
      if (url.hostname === 'images.example.com' && url.pathname === '/v1/images/generations') {
        forwarded = await request.json() as Record<string, unknown>;
        return jsonResponse({ data: [{ b64_json: 'aGVsbG8=' }], usage: { input_tokens: 10, output_tokens: 50 } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a shiba in space' }),
      });
      assertEquals(response.status, 200);
      const body = await response.json() as { data: { b64_json: string }[] };
      assertEquals(body.data[0].b64_json, 'aGVsbG8=');
      await flushAsyncWork();
    },
  );
  assertExists(forwarded);
  assertEquals(forwarded.model, 'gpt-image-2');
  assertEquals(forwarded.prompt, 'a shiba in space');
  const usageRows = await repo.usage.listAll();
  assertEquals(usageRows.some(row => row.model === 'gpt-image-2' && tokenCountsFromUsage(row).input === 10 && tokenCountsFromUsage(row).output === 50), true);
});

test('/v1/images/edits forwards a multipart request through an Azure model and records usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  clearInProcessCopilotTokenCache();
  await saveUpstreamForTest(repo.upstreams, {
    id: 'az-image',
    kind: 'azure',
    name: 'azure-images',
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 1,
    createdAt: '2026-05-25T00:00:00Z',
    updatedAt: '2026-05-25T00:00:00Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: MOCKED_FETCH_EGRESS,
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'azkey',
      models: [{
        upstreamModelId: 'gpt-image-2',
        endpoints: { openaiImagesEdits: {} },
      }],
    },
    state: null,
  });

  let observedUrl: string | undefined;
  let observedForm: FormData | undefined;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.hostname === 'example.openai.azure.com') {
        observedUrl = request.url;
        observedForm = await request.formData();
        return jsonResponse({ data: [{ b64_json: 'aGk=' }], usage: { input_tokens: 7, output_tokens: 11 } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const form = new FormData();
      form.append('model', 'gpt-image-2');
      form.append('prompt', 'replace sky with aurora');
      form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'photo.png');
      const response = await requestAppWithWarmModels('/v1/images/edits', {
        method: 'POST',
        headers: { 'x-api-key': apiKey.key },
        body: form,
      });
      assertEquals(response.status, 200);
      const body = await response.json() as { data: { b64_json: string }[] };
      assertEquals(body.data[0].b64_json, 'aGk=');
      await flushAsyncWork();
    },
  );
  assertEquals(observedUrl?.endsWith('?api-version=preview'), true);
  assertEquals(observedForm?.get('model'), 'gpt-image-2');
  const usageRows = await repo.usage.listAll();
  assertEquals(usageRows.some(row => row.model === 'gpt-image-2' && tokenCountsFromUsage(row).input === 7 && tokenCountsFromUsage(row).output === 11), true);
});

test('/v1/images/edits forwards JSON image references through a custom provider', async () => {
  const { apiKey, repo } = await setupAppTest();
  clearInProcessCopilotTokenCache();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_image_edits_json',
    name: 'Custom Image Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://images.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-images',
      endpoints: {},
    },
  }));

  let forwarded: Record<string, unknown> | undefined;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.hostname === 'images.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ data: [{ id: 'gpt-image-2' }] });
      }
      if (url.hostname === 'images.example.com' && url.pathname === '/v1/images/edits') {
        forwarded = await request.json() as Record<string, unknown>;
        return jsonResponse({ data: [{ b64_json: 'ZWRpdA==' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/images/edits', {
        method: 'POST',
        headers: { 'content-type': 'Application/Vnd.OpenAI+JSON; charset=utf-8', 'x-api-key': apiKey.key },
        body: JSON.stringify({
          model: 'gpt-image-2',
          prompt: 'replace the background',
          images: [
            { image_url: `data:image/png;base64,${PNG_B64}` },
            { file_id: 'file-source' },
          ],
          mask: { file_id: 'file-mask' },
          quality: 'high',
        }),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { data: [{ b64_json: 'ZWRpdA==' }] });
    },
  );

  assertEquals(forwarded, {
    model: 'gpt-image-2',
    prompt: 'replace the background',
    images: [
      { image_url: `data:image/png;base64,${PNG_B64}` },
      { file_id: 'file-source' },
    ],
    mask: { file_id: 'file-mask' },
    quality: 'high',
  });
});
