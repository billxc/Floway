import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { createCopilotCliCredentialProvider } from '../src/copilot-cli-credentials.ts';

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('node:child_process', () => ({ fork }));

const account = { host: 'github.com', login: 'tester_emu' };
let child: EventEmitter & { kill: ReturnType<typeof vi.fn> };
beforeEach(() => {
  fork.mockReset();
  child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  fork.mockReturnValue(child);
});
afterEach(() => vi.useRealTimers());

test('rejects invalid runtimePath overrides at construction', () => {
  expect(() => createCopilotCliCredentialProvider('relative/runtime.node')).toThrow('FLOWAY_COPILOT_CLI_RUNTIME_PATH');
  expect(() => createCopilotCliCredentialProvider('/abs/other.node')).toThrow('FLOWAY_COPILOT_CLI_RUNTIME_PATH');
  expect(fork).not.toHaveBeenCalled();
});

test('listAccounts projects only host and login metadata', async () => {
  const provider = createCopilotCliCredentialProvider('/installed/copilot/runtime.node');
  const pending = provider.listAccounts();
  child.emit('message', { ok: true, accounts: [{ host: 'github.com', login: 'tester_emu', token: 'secret-not-for-api' }] });
  expect(await pending).toEqual([account]);
  expect(fork.mock.calls[0][1]).toEqual(['/installed/copilot/runtime.node', 'accounts']);
});

test('readCredential transfers token over IPC with stdout and stderr disabled', async () => {
  const provider = createCopilotCliCredentialProvider('/installed/copilot/runtime.node');
  const pending = provider.readCredential(account);
  child.emit('message', { ok: true, token: 'ipc-secret' });
  expect(await pending).toEqual({ token: 'ipc-secret' });
  const [, args, options] = fork.mock.calls[0];
  expect(args).toEqual(['/installed/copilot/runtime.node', 'read', 'https://github.com', 'tester_emu']);
  expect(options.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc']);
  expect(JSON.stringify(fork.mock.calls)).not.toContain('ipc-secret');
  expect(child.kill).toHaveBeenCalledOnce();
});

test.each([{ host: 'tenant.ghe.com', login: 'tester' }, { host: 'github.com', login: '' }])('rejects unsupported account identities before spawning a worker', async invalid => {
  await expect(createCopilotCliCredentialProvider('/installed/copilot/runtime.node').readCredential(invalid)).rejects.toThrow('Invalid Copilot CLI account identity');
  expect(fork).not.toHaveBeenCalled();
});

test.each([{ ok: false, error: 'secret-in-native-error' }, { ok: true, token: '' }, { ok: true, token: 42 }])('invalid worker responses fail closed without exposing native details', async message => {
  const pending = createCopilotCliCredentialProvider('/installed/copilot/runtime.node').readCredential(account);
  child.emit('message', message);
  await expect(pending).rejects.toThrow('Copilot CLI credential unavailable');
  await expect(pending).rejects.not.toThrow('secret-in-native-error');
});

test('timeout and abort terminate the credential subprocess', async () => {
  vi.useFakeTimers();
  const provider = createCopilotCliCredentialProvider('/installed/copilot/runtime.node');
  const timed = provider.readCredential(account);
  const rejection = expect(timed).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(15_000);
  await rejection;
  expect(child.kill).toHaveBeenCalledOnce();

  vi.useRealTimers();
  const controller = new AbortController();
  const aborted = provider.readCredential(account, controller.signal);
  const reason = new Error('client disconnected');
  controller.abort(reason);
  await expect(aborted).rejects.toBe(reason);
});
