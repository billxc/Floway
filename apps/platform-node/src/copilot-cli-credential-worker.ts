import { createRequire } from 'node:module';

// The private CLI runtime reads its secret store by host + login. Its interface
// is deliberately isolated here; incompatible versions fail closed.
// https://github.com/github/copilot-cli
const read = async (): Promise<void> => {
  if (!process.send || !process.connected) throw new Error('Copilot credential worker requires IPC');
  const [runtimePath, host, login] = process.argv.slice(2);
  try {
    const require = createRequire(import.meta.url);
    const runtime = require(runtimePath) as {
      authGetTokenForAuthInfo?: (info: string) => Promise<unknown>;
    };
    if (typeof runtime.authGetTokenForAuthInfo !== 'function') throw new Error('Unsupported Copilot CLI runtime');
    const token = await runtime.authGetTokenForAuthInfo(JSON.stringify({ type: 'user', host, login }));
    if (typeof token !== 'string' || token.trim() === '') throw new Error('Copilot CLI credential unavailable');
    process.send({ ok: true, token }, () => process.disconnect());
  } catch {
    // Native credential errors can include secrets; never send raw errors or print them.
    process.send({ ok: false }, () => {
      process.disconnect();
      process.exitCode = 1;
    });
  }
};

await read();
