import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const worker = fileURLToPath(new URL('../src/copilot-cli-credential-worker.ts', import.meta.url));
const runtime = fileURLToPath(new URL('./fixtures/copilot-cli/runtime.cjs', import.meta.url));

const runWorker = async (login: string, runtimePath = runtime, action: 'accounts' | 'read' = 'read'): Promise<unknown> => await new Promise((resolve, reject) => {
  const child = fork(worker, [runtimePath, action, 'https://github.com', login], {
    execArgv: ['--import', import.meta.resolve('tsx')],
    env: { ...process.env, COPILOT_HOME: fileURLToPath(new URL('./fixtures/copilot-cli/', import.meta.url)) },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const timer = setTimeout(() => { child.kill(); reject(new Error('worker timed out')); }, 10_000);
  child.once('message', message => { clearTimeout(timer); child.kill(); resolve(message); });
  child.once('error', error => { clearTimeout(timer); child.kill(); reject(error); });
  child.once('exit', () => { clearTimeout(timer); reject(new Error('worker exited without a message')); });
});

test('account discovery returns only GitHub login metadata without loading native runtime', async () => {
  expect(await runWorker('tester', '/missing/runtime.node', 'accounts')).toEqual({ ok: true, accounts: [{ host: 'github.com', login: 'tester' }] });
});

test('worker transfers the selected signed-in credential over IPC and rejects unsigned accounts', async () => {
  expect(await runWorker('tester')).toEqual({ ok: true, token: 'synthetic-ipc-token' });
  expect(await runWorker('not-signed-in')).toEqual({ ok: false });
});

test('an unsupported CLI runtime fails without exposing module error details', async () => {
  expect(await runWorker('tester', '/missing/runtime.node')).toEqual({ ok: false });
});
