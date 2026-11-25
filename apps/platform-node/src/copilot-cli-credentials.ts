import { access, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type { LocalCredentialAccount, LocalCredentialProvider } from '@floway-dev/platform';

interface CopilotCliRuntime {
  authGetTokenForAuthInfo?: (info: string) => Promise<unknown>;
}

const copilotHome = (): string => process.env.COPILOT_HOME ?? join(homedir(), '.copilot');

// Copilot CLI's config.json may contain JSONC comments and trailing commas.
const parseJsonc = (text: string): unknown => {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\' && next !== undefined) {
        out += next;
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      i += 1;
      while (i + 1 < text.length && text[i + 1] !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      i += 1;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
};

export const readCopilotCliAccounts = async (): Promise<LocalCredentialAccount[]> => {
  let text: string;
  try {
    text = await readFile(join(copilotHome(), 'config.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const config: unknown = parseJsonc(text);
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('Invalid Copilot CLI config.json: expected an object');
  }
  const users = (config as Record<string, unknown>).loggedInUsers;
  if (users === undefined) return [];
  if (!Array.isArray(users)) throw new Error('Invalid Copilot CLI config.json: loggedInUsers must be an array');

  const accounts = new Map<string, LocalCredentialAccount>();
  for (const user of users) {
    if (
      typeof user !== 'object'
      || user === null
      || user.host !== 'https://github.com'
      || (user.kind !== 'githubDotCom' && user.kind !== 'entraEmu')
    ) continue;
    if (typeof user.login !== 'string' || user.login.trim() === '') {
      throw new Error('Invalid Copilot CLI GitHub account login');
    }
    accounts.set(user.login.toLowerCase(), { host: 'github.com', login: user.login });
  }
  return [...accounts.values()];
};

const resolveRuntimePath = async (configured?: string): Promise<string> => {
  if (configured !== undefined && configured !== '') return configured;
  const platform = `${process.platform}-${process.arch}`;
  const pkgRoot = join(copilotHome(), 'pkg', platform);
  const versions = (await readdir(pkgRoot)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = join(pkgRoot, version, 'prebuilds', platform, 'runtime.node');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Skip incomplete bundle directories and try older installed versions.
    }
  }
  throw new Error(`Copilot CLI runtime.node not found under ${pkgRoot}`);
};

// Reads tokens directly via the local Copilot CLI native runtime addon.
// https://github.com/github/copilot-cli
export const createCopilotCliCredentialProvider = (runtimePath?: string): LocalCredentialProvider => {
  if (runtimePath !== undefined && runtimePath !== '' && !isAbsolute(runtimePath)) {
    throw new Error('FLOWAY_COPILOT_CLI_RUNTIME_PATH must be an absolute path');
  }

  let loadedRuntime: CopilotCliRuntime | null = null;
  const loadRuntime = async (): Promise<CopilotCliRuntime> => {
    if (loadedRuntime !== null) return loadedRuntime;
    const require = createRequire(import.meta.url);
    const mod = require(await resolveRuntimePath(runtimePath)) as CopilotCliRuntime;
    if (typeof mod.authGetTokenForAuthInfo !== 'function') {
      throw new Error('Unsupported Copilot CLI runtime: missing authGetTokenForAuthInfo');
    }
    loadedRuntime = mod;
    return mod;
  };

  return {
    listAccounts: async signal => {
      signal?.throwIfAborted();
      return await readCopilotCliAccounts();
    },
    readCredential: async (account, signal) => {
      signal?.throwIfAborted();
      if (account.host !== 'github.com' || account.login.trim() === '') {
        throw new Error(`Invalid Copilot CLI account identity: ${account.host}/${account.login}`);
      }
      const accounts = await readCopilotCliAccounts();
      const matched = accounts.find(entry => entry.login.toLowerCase() === account.login.toLowerCase());
      if (matched === undefined) {
        throw new Error(`Copilot CLI account "${account.login}" is not signed in locally`);
      }
      const runtime = await loadRuntime();
      const token = await runtime.authGetTokenForAuthInfo!(JSON.stringify({
        type: 'user',
        host: 'https://github.com',
        login: matched.login,
      }));
      if (typeof token !== 'string' || token.trim() === '') {
        throw new Error(`Copilot CLI credential unavailable for "${matched.login}"`);
      }
      return { token };
    },
  };
};
