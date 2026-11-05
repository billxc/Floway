import { access, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse, type ParseError } from 'jsonc-parser';

import type { LocalCredentialAccount } from '@floway-dev/platform';

const copilotHome = (): string => process.env.COPILOT_HOME ?? join(homedir(), '.copilot');

export const readCopilotCliAccounts = async (): Promise<LocalCredentialAccount[]> => {
  let text: string;
  try {
    text = await readFile(join(copilotHome(), 'config.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('Copilot CLI account configuration could not be read');
  }
  const errors: ParseError[] = [];
  const config: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error('Invalid Copilot CLI account configuration');
  const users = (config as Record<string, unknown>).loggedInUsers;
  if (users === undefined) return [];
  if (!Array.isArray(users)) throw new Error('Invalid Copilot CLI account list');
  const accounts = new Map<string, LocalCredentialAccount>();
  for (const user of users) {
    if (typeof user !== 'object' || user === null || user.host !== 'https://github.com' || (user.kind !== 'githubDotCom' && user.kind !== 'entraEmu')) continue;
    if (typeof user.login !== 'string' || user.login.trim() === '') throw new Error('Invalid Copilot CLI GitHub account');
    accounts.set(user.login.toLowerCase(), { host: 'github.com', login: user.login });
  }
  return [...accounts.values()];
};

const resolveRuntimePath = async (configured: string): Promise<string> => {
  if (configured !== '') return configured;
  const platform = `${process.platform}-${process.arch}`;
  const pkgRoot = join(copilotHome(), 'pkg', platform);
  const versions = (await readdir(pkgRoot)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = join(pkgRoot, version, 'prebuilds', platform, 'runtime.node');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try older installed bundles when an incomplete directory is present.
    }
  }
  throw new Error('Copilot CLI runtime.node not found');
};

// The private CLI runtime reads its secret store by host + login. Its interface
// is deliberately isolated here; incompatible versions fail closed.
// https://github.com/github/copilot-cli
if (process.send && process.connected) {
  const [runtimeArg = '', action = '', host = '', login = ''] = process.argv.slice(2);
  try {
    const accounts = await readCopilotCliAccounts();
    if (action === 'accounts') {
      process.send({ ok: true, accounts }, () => process.disconnect());
    } else {
      if (!accounts.some(account => account.login.toLowerCase() === login.toLowerCase())) throw new Error('Copilot CLI account is not signed in');
      const require = createRequire(import.meta.url);
      const runtime = require(await resolveRuntimePath(runtimeArg)) as {
        authGetTokenForAuthInfo?: (info: string) => Promise<unknown>;
      };
      if (typeof runtime.authGetTokenForAuthInfo !== 'function') throw new Error('Unsupported Copilot CLI runtime');
      const token = await runtime.authGetTokenForAuthInfo(JSON.stringify({ type: 'user', host, login }));
      if (typeof token !== 'string' || token.trim() === '') throw new Error('Copilot CLI credential unavailable');
      process.send({ ok: true, token }, () => process.disconnect());
    }
  } catch {
    // Native credential errors can include secrets; never send raw errors or print them.
    process.send({ ok: false }, () => {
      process.disconnect();
      process.exitCode = 1;
    });
  }
}
