import { fork } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LocalCredentialProvider } from '@floway-dev/platform';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const callWorker = async (runtimePath: string, args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> => {
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./copilot-cli-credential-worker.ts', import.meta.url)), [runtimePath, ...args], {
      execArgv: ['--import', import.meta.resolve('tsx')],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    const finish = (error: Error | null, message?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.kill();
      if (error !== null) reject(error);
      else if (message !== undefined) resolve(message);
      else reject(new Error('Copilot CLI credential reader returned no credential'));
    };
    const abort = (): void => finish(signal?.reason instanceof Error ? signal.reason : new Error('Copilot CLI credential lookup aborted'));
    const timer = setTimeout(() => finish(new Error('Copilot CLI credential lookup timed out')), 15_000);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('message', (message: unknown) => {
      if (isRecord(message) && message.ok === true) finish(null, message);
      else finish(new Error('Copilot CLI credential unavailable; sign in with the configured CLI account'));
    });
    child.once('error', () => finish(new Error('Copilot CLI credential reader could not start')));
    child.once('exit', () => finish(new Error('Copilot CLI credential reader exited without a credential')));
    if (signal?.aborted) abort();
  });
};

export const createCopilotCliCredentialProvider = (runtimePath?: string): LocalCredentialProvider => {
  if (runtimePath !== undefined && (!isAbsolute(runtimePath) || basename(runtimePath) !== 'runtime.node')) {
    throw new Error('FLOWAY_COPILOT_CLI_RUNTIME_PATH must be an absolute runtime.node path');
  }
  const resolvedPath = runtimePath ?? '';
  return {
    listAccounts: async signal => {
      const message = await callWorker(resolvedPath, ['accounts'], signal);
      if (!Array.isArray(message.accounts)) throw new Error('Invalid Copilot CLI account response');
      return message.accounts.map(account => {
        if (!isRecord(account) || account.host !== 'github.com' || typeof account.login !== 'string' || !account.login) {
          throw new Error('Invalid Copilot CLI account response');
        }
        return { host: account.host, login: account.login };
      });
    },
    readCredential: async (account, signal) => {
      if (account.host !== 'github.com' || !/^[a-z\d](?:[a-z\d_-]*[a-z\d])?$/i.test(account.login)) {
        throw new Error('Invalid Copilot CLI account identity');
      }
      const message = await callWorker(resolvedPath, ['read', 'https://github.com', account.login], signal);
      if (typeof message.token !== 'string' || message.token.trim() === '') throw new Error('Copilot CLI credential unavailable');
      return { token: message.token };
    },
  };
};
