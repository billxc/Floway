import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { createCopilotCliCredentialReader } from '../src/copilot-cli-credentials.ts';

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('node:child_process', () => ({ fork }));

const identity = { upstreamId: 'up_local', host: 'github.com', login: 'tester' };
const configuration = JSON.stringify({ up_local: { login: 'tester', runtimePath: '/installed/copilot/runtime.node' } });
let child: EventEmitter & { kill: ReturnType<typeof vi.fn> };
beforeEach(() => {
  fork.mockReset();
  child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  fork.mockReturnValue(child);
});
afterEach(() => vi.useRealTimers());

test('local credential access is opt-in for an explicit upstream binding', async () => {
  expect(createCopilotCliCredentialReader(undefined)).toBeNull();
  const reader = createCopilotCliCredentialReader(configuration)!;
  expect(await reader({ ...identity, upstreamId: 'unbound' })).toBeNull();
  expect(fork).not.toHaveBeenCalled();
});

test.each(['', 'null', '[]', '"value"', '{', '{"up_local":{"login":"tester","runtimePath":"relative/runtime.node"}}', '{"up_local":{"login":"tester","runtimePath":"/a/runtime.node","token":"forbidden"}}'])('invalid binding is rejected at startup: %s', value => {
  expect(() => createCopilotCliCredentialReader(value)).toThrow('FLOWAY_COPILOT_CLI_AUTH');
  expect(fork).not.toHaveBeenCalled();
});

test.each([{ ...identity, host: 'tenant.ghe.com' }, { ...identity, login: 'another-user' }])('another account cannot use an existing binding', async value => {
  await expect(createCopilotCliCredentialReader(configuration)!(value)).rejects.toThrow('does not match');
  expect(fork).not.toHaveBeenCalled();
});

test('credential travels through IPC, with stdout and stderr disabled', async () => {
  const emuConfiguration = JSON.stringify({ up_local: { login: 'tester_emu', runtimePath: '/installed/copilot/runtime.node' } });
  const reader = createCopilotCliCredentialReader(emuConfiguration)!;
  const pending = reader({ ...identity, login: 'TESTER_EMU' });
  child.emit('message', { ok: true, token: 'ipc-secret' });
  expect(await pending).toEqual({ token: 'ipc-secret' });
  const [, args, options] = fork.mock.calls[0];
  expect(args).toEqual(['/installed/copilot/runtime.node', 'https://github.com', 'tester_emu']);
  expect(options.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc']);
  expect(JSON.stringify(fork.mock.calls)).not.toContain('ipc-secret');
  expect(child.kill).toHaveBeenCalledOnce();
  const second = reader({ ...identity, login: 'tester_emu' });
  child.emit('message', { ok: true, token: 'rotated-secret' });
  expect(await second).toEqual({ token: 'rotated-secret' });
  expect(fork).toHaveBeenCalledTimes(2);
});

test.each([{ ok: false, error: 'secret-in-native-error' }, { ok: true, token: '' }, { ok: true, token: 42 }])('invalid worker responses fail closed without exposing native details', async message => {
  const pending = createCopilotCliCredentialReader(configuration)!(identity);
  child.emit('message', message);
  await expect(pending).rejects.toThrow('Copilot CLI credential unavailable');
  await expect(pending).rejects.not.toThrow('secret-in-native-error');
});

test('child failure does not expose raw error details', async () => {
  const pending = createCopilotCliCredentialReader(configuration)!(identity);
  child.emit('error', new Error('secret-in-native-error'));
  await expect(pending).rejects.toThrow('could not start');
  await expect(pending).rejects.not.toThrow('secret-in-native-error');
});

test('a worker exiting without a message is a failure', async () => {
  const pending = createCopilotCliCredentialReader(configuration)!(identity);
  child.emit('exit', 0);
  await expect(pending).rejects.toThrow('without a credential');
});

test('timeout terminates the credential subprocess', async () => {
  vi.useFakeTimers();
  const pending = createCopilotCliCredentialReader(configuration)!(identity);
  const rejection = expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(15_000);
  await rejection;
  expect(child.kill).toHaveBeenCalledOnce();
});

test('abort terminates the subprocess and preserves the abort reason', async () => {
  const controller = new AbortController();
  const pending = createCopilotCliCredentialReader(configuration)!(identity, controller.signal);
  const reason = new Error('client disconnected');
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(child.kill).toHaveBeenCalledOnce();
});

test('pre-aborted reads never start a subprocess', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(createCopilotCliCredentialReader(configuration)!(identity, controller.signal)).rejects.toBe(controller.signal.reason);
  expect(fork).not.toHaveBeenCalled();
});
