import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const worker = fileURLToPath(new URL('../src/copilot-cli-credential-worker.ts', import.meta.url));
const runtime = fileURLToPath(new URL('./fixtures/copilot-cli/runtime.cjs', import.meta.url));

const read = async (login: string, runtimePath = runtime): Promise<unknown> => await new Promise((resolve, reject) => {
  const child = fork(worker, [runtimePath, 'https://github.com', login], {
    execArgv: ['--import', import.meta.resolve('tsx')],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const timer = setTimeout(() => { child.kill(); reject(new Error('worker timed out')); }, 10_000);
  child.once('message', message => { clearTimeout(timer); child.kill(); resolve(message); });
  child.once('error', error => { clearTimeout(timer); child.kill(); reject(error); });
  child.once('exit', () => { clearTimeout(timer); reject(new Error('worker exited without a message')); });
});

test('actual worker transfers the selected credential over IPC', async () => {
  expect(await read('tester')).toEqual({ ok: true, token: 'synthetic-ipc-token' });
});

test.each(['error', 'missing'])('actual worker hides native errors and missing credentials for %s', async login => {
  const message = await read(login);
  expect(message).toEqual({ ok: false });
  expect(JSON.stringify(message)).not.toContain('synthetic-secret');
});

test('an unsupported CLI runtime fails without exposing module error details', async () => {
  expect(await read('tester', '/missing/runtime.node')).toEqual({ ok: false });
});
