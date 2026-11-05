import { normalizeGitHubHost } from './github-host.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

export interface CopilotUpstreamUser {
  login: string;
  avatar_url: string;
  name: string | null;
  id: number;
}

export interface CopilotUpstreamConfig {
  githubHost: string;
  githubToken: string;
  credentialSource?: 'copilot-cli';
  user: CopilotUpstreamUser;
}

export type CopilotUpstreamRecord = UpstreamRecord & {
  kind: 'copilot';
  config: CopilotUpstreamConfig;
};

type FieldErrorBuilder = (field: string, expected: string) => Error;

const malformedConfig: FieldErrorBuilder = (field, expected) => new Error(`Malformed copilot upstream config: ${field} must be ${expected}`);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const stringField = (value: unknown, field: string, err: FieldErrorBuilder): string => {
  if (typeof value !== 'string') throw err(field, 'a string');
  return value;
};

const nonEmptyStringField = (value: unknown, field: string, err: FieldErrorBuilder): string => {
  const str = stringField(value, field, err).trim();
  if (str === '') throw err(field, 'a non-empty string');
  return str;
};

const githubHostField = (value: unknown, err: FieldErrorBuilder): string => {
  const host = stringField(value, 'githubHost', err);
  try {
    return normalizeGitHubHost(host);
  } catch {
    throw err('githubHost', 'github.com or a tenant hostname ending in .ghe.com');
  }
};

const nullableStringField = (value: unknown, field: string, err: FieldErrorBuilder): string | null => {
  if (value !== null && typeof value !== 'string') throw err(field, 'a string or null');
  return value;
};

const integerField = (value: unknown, field: string, err: FieldErrorBuilder): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw err(field, 'an integer');
  return value;
};

const copilotUserField = (value: unknown, err: FieldErrorBuilder, requireIdentity = false): CopilotUpstreamUser => {
  if (!isRecord(value)) throw err('user', 'an object');
  if (requireIdentity && integerField(value.id, 'user.id', err) <= 0) throw err('user.id', 'a positive integer');
  return {
    login: requireIdentity ? nonEmptyStringField(value.login, 'user.login', err) : stringField(value.login, 'user.login', err),
    avatar_url: stringField(value.avatar_url, 'user.avatar_url', err),
    name: nullableStringField(value.name, 'user.name', err),
    id: integerField(value.id, 'user.id', err),
  };
};

const credentialFields = (value: Record<string, unknown>, err: FieldErrorBuilder, requireToken: boolean): Pick<CopilotUpstreamConfig, 'githubToken' | 'credentialSource'> => {
  if (value.credentialSource !== undefined && value.credentialSource !== 'copilot-cli') {
    throw err('credentialSource', 'copilot-cli or omitted');
  }
  if (value.credentialSource === 'copilot-cli') {
    if (githubHostField(value.githubHost, err) !== 'github.com') throw err('githubHost', 'github.com for Copilot CLI credentials');
    if (stringField(value.githubToken ?? '', 'githubToken', err) !== '') throw err('githubToken', 'empty for Copilot CLI credentials');
    return { githubToken: '', credentialSource: 'copilot-cli' };
  }
  return { githubToken: requireToken ? nonEmptyStringField(value.githubToken, 'githubToken', err) : stringField(value.githubToken, 'githubToken', err) };
};

// Grammar for an incoming config payload. The caller supplies the error
// builder because the surfaces that accept such a payload word their
// rejections differently.
export const parseCopilotUpstreamConfig = (value: unknown, err: FieldErrorBuilder): CopilotUpstreamConfig => {
  if (!isRecord(value)) throw err('config', 'an object');
  return {
    githubHost: githubHostField(value.githubHost, err),
    ...credentialFields(value, err, true),
    user: copilotUserField(value.user, err, value.credentialSource === 'copilot-cli'),
  };
};

export const assertCopilotUpstreamRecord = (record: UpstreamRecord): CopilotUpstreamRecord => {
  if (record.kind !== 'copilot') throw new Error(`Expected copilot upstream record, got ${record.kind}`);
  if (!isRecord(record.config)) throw malformedConfig('config', 'an object');
  return {
    ...record,
    kind: 'copilot',
    config: {
      githubHost: githubHostField(record.config.githubHost, malformedConfig),
      ...credentialFields(record.config, malformedConfig, false),
      user: copilotUserField(record.config.user, malformedConfig, record.config.credentialSource === 'copilot-cli'),
    },
  };
};
