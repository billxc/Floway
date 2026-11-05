import { afterEach, expect, test, vi } from 'vitest';

import { initLocalCredentialProvider, listLocalCredentialAccounts, localCredentialProviderEnabled, readLocalCredential } from '../src/local-credential.ts';

const account = { host: 'github.com', login: 'tester' };
afterEach(() => initLocalCredentialProvider(null));

test('unconfigured local credential provider fails closed', async () => {
  initLocalCredentialProvider(null);
  expect(localCredentialProviderEnabled()).toBe(false);
  await expect(listLocalCredentialAccounts()).rejects.toThrow('not enabled');
  await expect(readLocalCredential(account)).rejects.toThrow('not enabled');
});

test('local credential provider forwards account identity, abort signal, and fresh reads', async () => {
  const signal = new AbortController().signal;
  const listAccounts = vi.fn(async () => [account]);
  const readCredential = vi.fn().mockResolvedValueOnce({ token: 'first' }).mockResolvedValueOnce({ token: 'second' });
  initLocalCredentialProvider({ listAccounts, readCredential });
  expect(localCredentialProviderEnabled()).toBe(true);
  expect(await listLocalCredentialAccounts(signal)).toEqual([account]);
  expect(listAccounts).toHaveBeenCalledWith(signal);
  expect(await readLocalCredential(account, signal)).toEqual({ token: 'first' });
  expect(await readLocalCredential(account, signal)).toEqual({ token: 'second' });
  expect(readCredential).toHaveBeenCalledTimes(2);
});
