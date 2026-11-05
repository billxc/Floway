export interface LocalCredentialAccount {
  readonly host: string;
  readonly login: string;
}

export interface LocalCredential {
  readonly token: string;
}

export interface LocalCredentialProvider {
  listAccounts(signal?: AbortSignal): Promise<readonly LocalCredentialAccount[]>;
  readCredential(account: LocalCredentialAccount, signal?: AbortSignal): Promise<LocalCredential>;
}

let provider: LocalCredentialProvider | null = null;

export const initLocalCredentialProvider = (value: LocalCredentialProvider | null): void => {
  provider = value;
};

export const localCredentialProviderEnabled = (): boolean => provider !== null;

export const listLocalCredentialAccounts = async (signal?: AbortSignal): Promise<readonly LocalCredentialAccount[]> => {
  if (provider === null) throw new Error('Local Copilot CLI credentials are not enabled on this runtime');
  return await provider.listAccounts(signal);
};

export const readLocalCredential = async (account: LocalCredentialAccount, signal?: AbortSignal): Promise<LocalCredential> => {
  if (provider === null) throw new Error('Local Copilot CLI credentials are not enabled on this runtime');
  return await provider.readCredential(account, signal);
};
