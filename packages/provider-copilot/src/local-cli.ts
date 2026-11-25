import { readLocalCredential } from '@floway-dev/platform';

// Copilot CLI OAuth tokens authenticate directly against api.githubcopilot.com
// using the `copilot-cli` integration id without the VS Code token exchange.
// https://github.com/github/copilot-cli
export const COPILOT_CLI_CREDENTIAL_SOURCE = 'copilot-cli' as const;
export const COPILOT_CLI_BASE_URL = 'https://api.githubcopilot.com';
export const COPILOT_CLI_INTEGRATION_ID = 'copilot-cli';
export const COPILOT_CLI_USER_AGENT = 'Floway';

export type CopilotCredentialSource = typeof COPILOT_CLI_CREDENTIAL_SOURCE;

export const isCopilotCliCredential = (value: { credentialSource?: string }): boolean =>
  value.credentialSource === COPILOT_CLI_CREDENTIAL_SOURCE;

export const resolveCopilotCliToken = async (
  auth: { githubHost: string; githubLogin?: string },
  signal?: AbortSignal,
): Promise<{ token: string; baseUrl: string }> => {
  const { token } = await readLocalCredential({ host: auth.githubHost, login: auth.githubLogin ?? '' }, signal);
  return { token, baseUrl: COPILOT_CLI_BASE_URL };
};

export const resolveCopilotUsageToken = async (
  githubHost: string,
  githubToken: string,
  cliLogin?: string,
): Promise<string> => {
  if (cliLogin === undefined) return githubToken;
  const { token } = await readLocalCredential({ host: githubHost, login: cliLogin });
  return token;
};
