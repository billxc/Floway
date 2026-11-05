import { afterEach, expect, test, vi } from 'vitest';

import { initLocalCredentialReader, readLocalCredential } from '../src/local-credential.ts';

const identity = { upstreamId: 'up_local', host: 'github.com', login: 'tester' };
afterEach(() => initLocalCredentialReader(null));

test('unconfigured local credentials do not change existing authentication', async () => {
  initLocalCredentialReader(null);
  expect(await readLocalCredential(identity)).toBeNull();
});

test('local credential reads preserve identity, abort signal, and original failure', async () => {
  const failure = new Error('credential unavailable');
  const signal = new AbortController().signal;
  const reader = vi.fn(async () => { throw failure; });
  initLocalCredentialReader(reader);
  await expect(readLocalCredential(identity, signal)).rejects.toBe(failure);
  expect(reader).toHaveBeenCalledWith(identity, signal);
});

test('local credentials are read afresh instead of cached by the platform', async () => {
  const reader = vi.fn().mockResolvedValueOnce({ token: 'first' }).mockResolvedValueOnce({ token: 'second' });
  initLocalCredentialReader(reader);
  expect(await readLocalCredential(identity)).toEqual({ token: 'first' });
  expect(await readLocalCredential(identity)).toEqual({ token: 'second' });
  expect(reader).toHaveBeenCalledTimes(2);
});
