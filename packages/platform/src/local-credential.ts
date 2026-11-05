export interface LocalCredentialIdentity {
  readonly upstreamId: string;
  readonly host: string;
  readonly login: string;
}

export interface LocalCredential {
  readonly token: string;
}

export type LocalCredentialReader = (identity: LocalCredentialIdentity, signal?: AbortSignal) => Promise<LocalCredential | null>;

let reader: LocalCredentialReader | null = null;

export const initLocalCredentialReader = (value: LocalCredentialReader | null): void => {
  reader = value;
};

// Null means the operator did not opt this upstream into a local source.
// A configured source must throw on failure rather than fall back to stored credentials.
export const readLocalCredential = async (identity: LocalCredentialIdentity, signal?: AbortSignal): Promise<LocalCredential | null> =>
  reader === null ? null : await reader(identity, signal);
