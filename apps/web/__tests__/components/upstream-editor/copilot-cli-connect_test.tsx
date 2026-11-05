import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { valuesFromRecord, type UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { ProviderConfigSection } from '../../../src/components/upstream-editor/provider-config';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';
import { advance } from '../../settle';

const t = (key: string) => i18n.t(`dashboard.upstreamEditor.copilot.${key}`);
const seed = upstreamRecord('', { kind: 'copilot', config: { githubHost: 'github.com', githubToken: '', user: { login: '', id: 0, name: null, avatar_url: '' } }, state: null });
const patch = { config: { githubHost: 'github.com', githubToken: '', credentialSource: 'copilot-cli', user: { login: 'local-user', id: 123, name: 'Local User', avatar_url: '' } }, state: null };
const observed = vi.fn();
let enabled = true;
let connectReply = () => Promise.resolve(Response.json({ patch, models: [{ id: 'gpt-6-luna', name: 'Luna' }] }));

function Harness() {
  const [record, setRecord] = useState(seed);
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  return <FormProvider {...form}><ProviderConfigSection record={record} onRefreshModels={vi.fn()} onPatch={value => {
    observed(value);
    if (value.config !== undefined) form.setValue('config', value.config as UpstreamEditorValues['config']);
    if (value.state !== undefined) form.setValue('state', value.state as UpstreamEditorValues['state']);
    setRecord(current => ({ ...current, ...value }) as UpstreamRecord);
  }} /></FormProvider>;
}

const choose = async (label: string, value: string) => {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  await advance(0);
  fireEvent.click(screen.getByRole('option', { name: value }));
  await advance(0);
};

beforeEach(() => {
  vi.useFakeTimers(); observed.mockClear(); enabled = true;
  connectReply = () => Promise.resolve(Response.json({ patch, models: [{ id: 'gpt-6-luna', name: 'Luna' }] }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path.endsWith('/local/accounts')) return Response.json({ enabled, accounts: enabled ? [{ host: 'github.com', login: 'local-user' }] : [] });
    if (path.endsWith('/local/connect')) {
      const body = await request.json();
      expect(body.login).toBe('local-user');
      expect(body.record.config.githubToken).toBe('');
      return await connectReply();
    }
    throw new Error(`Unexpected test request ${path}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('choose CLI, select a saved account, verify, and show the account and models', async () => {
  renderInApp(<Harness />);
  await choose(t('credentialSource'), t('local.method'));
  expect(screen.queryByRole('button', { name: t('connect') })).toBeNull();
  const connect = screen.getByRole('button', { name: t('local.connect') }) as HTMLButtonElement;
  expect(connect.disabled).toBe(true);
  await choose(t('local.account'), 'local-user');
  expect(connect.disabled).toBe(false);
  fireEvent.click(connect); await advance(0);
  expect(screen.getByText('Local User')).toBeTruthy();
  expect(screen.getByText('gpt-6-luna')).toBeTruthy();
  expect(observed.mock.calls.at(-1)?.[0]).toEqual(patch);
});

test('a disabled local source explains the required Node configuration', async () => {
  enabled = false;
  renderInApp(<Harness />);
  await choose(t('credentialSource'), t('local.method'));
  expect(screen.getByText(t('local.disabled'))).toBeTruthy();
  expect((screen.getByRole('button', { name: t('local.connect') }) as HTMLButtonElement).disabled).toBe(true);
});

test('a rejected connection never marks the account as connected', async () => {
  connectReply = () => Promise.resolve(Response.json({ error: 'account unavailable' }, { status: 403 }));
  renderInApp(<Harness />);
  await choose(t('credentialSource'), t('local.method'));
  await choose(t('local.account'), 'local-user');
  fireEvent.click(screen.getByRole('button', { name: t('local.connect') })); await advance(0);
  expect(screen.getByText('account unavailable')).toBeTruthy();
  expect(screen.queryByText('Local User')).toBeNull();
});

test('switching auth method cancels a pending local verification', async () => {
  let release!: (response: Response) => void;
  connectReply = () => new Promise(resolve => { release = resolve; });
  renderInApp(<Harness />);
  await choose(t('credentialSource'), t('local.method'));
  await choose(t('local.account'), 'local-user');
  fireEvent.click(screen.getByRole('button', { name: t('local.connect') })); await advance(0);
  await choose(t('credentialSource'), t('deviceMethod'));
  release(Response.json({ patch, models: [{ id: 'gpt-6-luna', name: 'Luna' }] })); await advance(0);
  expect(screen.queryByText('Local User')).toBeNull();
  expect(screen.getByRole('button', { name: t('connect') })).toBeTruthy();
});
