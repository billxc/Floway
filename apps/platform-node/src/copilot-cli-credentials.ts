import { fork } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LocalCredential, LocalCredentialReader } from '@floway-dev/platform';

interface CopilotCliBinding {
  readonly login: string;
  readonly runtimePath: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const readCredential = async (binding: CopilotCliBinding, signal?: AbortSignal): Promise<LocalCredential> => {
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./copilot-cli-credential-worker.ts', import.meta.url)), [binding.runtimePath, 'https://github.com', binding.login], {
      execArgv: ['--import', import.meta.resolve('tsx')],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    const finish = (error: Error | null, credential?: LocalCredential): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.kill();
      if (error !== null) reject(error);
      else if (credential !== undefined) resolve(credential);
      else reject(new Error('Copilot CLI credential reader returned no credential'));
    };
    const abort = (): void => finish(signal?.reason instanceof Error ? signal.reason : new Error('Copilot CLI credential lookup aborted'));
    const timer = setTimeout(() => finish(new Error('Copilot CLI credential lookup timed out')), 15_000);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('message', (message: unknown) => {
      if (isRecord(message) && message.ok === true && typeof message.token === 'string' && message.token.trim() !== '') {
        finish(null, { token: message.token });
      } else {
        finish(new Error('Copilot CLI credential unavailable; sign in with the configured CLI account'));
      }
    });
    child.once('error', () => finish(new Error('Copilot CLI credential reader could not start')));
    child.once('exit', () => finish(new Error('Copilot CLI credential reader exited without a credential')));
    if (signal?.aborted) abort();
  });
};

export const createCopilotCliCredentialReader = (configuration: string | undefined): LocalCredentialReader | null => {
  if (configuration === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configuration);
  } catch {
    throw new Error('FLOWAY_COPILOT_CLI_AUTH must be a JSON object');
  }
  if (!isRecord(parsed)) throw new Error('FLOWAY_COPILOT_CLI_AUTH must be a JSON object');
  const bindings = new Map<string, CopilotCliBinding>();
  for (const [id, value] of Object.entries(parsed)) {
    if (!id || !isRecord(value) || Object.keys(value).some(key => key !== 'login' && key !== 'runtimePath')
      || typeof value.login !== 'string' || !/^[a-z\d](?:[a-z\d_-]*[a-z\d])?$/i.test(value.login)
      || typeof value.runtimePath !== 'string' || !isAbsolute(value.runtimePath) || basename(value.runtimePath) !== 'runtime.node') {
      throw new Error('Each FLOWAY_COPILOT_CLI_AUTH binding requires an upstream ID, GitHub login, and absolute runtime.node path');
    }
    bindings.set(id, { login: value.login, runtimePath: value.runtimePath });
  }
  return async (identity, signal) => {
    const binding = bindings.get(identity.upstreamId);
    if (binding === undefined) return null;
    if (identity.host !== 'github.com' || identity.login.toLowerCase() !== binding.login.toLowerCase()) {
      throw new Error('Copilot CLI credential binding does not match the upstream GitHub identity');
    }
    return await readCredential(binding, signal);
  };
};
