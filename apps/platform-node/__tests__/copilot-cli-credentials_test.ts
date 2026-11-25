import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCopilotCliCredentialProvider, readCopilotCliAccounts } from '../src/copilot-cli-credentials.ts';

describe('copilot-cli-credentials', () => {
  const dirs: string[] = [];
  const originalHome = process.env.COPILOT_HOME;

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = originalHome;
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const makeTempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'floway-copilot-cli-'));
    dirs.push(dir);
    return dir;
  };

  it('returns empty accounts when config.json does not exist', async () => {
    process.env.COPILOT_HOME = await makeTempDir();
    await expect(readCopilotCliAccounts()).resolves.toEqual([]);
  });

  it('reads githubDotCom and entraEmu accounts and resolves credentials via runtime', async () => {
    const dir = await makeTempDir();
    process.env.COPILOT_HOME = dir;
    await writeFile(join(dir, 'config.json'), [
      '// User settings for Copilot CLI',
      '{',
      '  "loggedInUsers": [',
      '    { "host": "https://github.com", "login": "octocat", "kind": "githubDotCom" },',
      '    { "host": "https://github.com", "login": "user_emu", "kind": "entraEmu" },',
      '    { "host": "https://corp.ghe.com", "login": "ghe-user", "kind": "githubDotCom" },',
      '  ],',
      '}',
    ].join('\n'));

    const runtimeFile = join(dir, 'runtime.cjs');
    await writeFile(runtimeFile, [
      'module.exports = {',
      '  authGetTokenForAuthInfo: async (raw) => {',
      '    const info = JSON.parse(raw);',
      '    return `ghu_${info.login}`;',
      '  },',
      '};',
    ].join('\n'));

    const provider = createCopilotCliCredentialProvider(runtimeFile);
    await expect(provider.listAccounts()).resolves.toEqual([
      { host: 'github.com', login: 'octocat' },
      { host: 'github.com', login: 'user_emu' },
    ]);
    await expect(provider.readCredential({ host: 'github.com', login: 'user_emu' })).resolves.toEqual({
      token: 'ghu_user_emu',
    });
    await expect(provider.readCredential({ host: 'github.com', login: 'missing' })).rejects.toThrow('not signed in locally');
  });
});
