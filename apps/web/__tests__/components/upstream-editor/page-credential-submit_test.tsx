import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useFormContext } from 'react-hook-form';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, expect, test, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { UpstreamEditorPage } from '../../../src/components/upstream-editor/page';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

const apiMocks = vi.hoisted(() => ({ create: vi.fn(), patch: vi.fn() }));

vi.mock('../../../src/api/client', () => ({
  api: { api: { upstreams: { $post: apiMocks.create, ':id': { $patch: apiMocks.patch } } } },
  callApi: (operation: () => unknown) => operation(),
}));

const imported = {
  config: { accounts: [{ email: 'operator@example.com', chatgptAccountId: null, chatgptUserId: null, planType: 'free' }] },
  state: {
    accounts: [{
      chatgptAccountId: null,
      refresh_token: 'refresh-token',
      state: 'active',
      state_updated_at: '2026-09-30T00:00:00.000Z',
      openaiDeviceId: 'device-id',
      accessToken: null,
      quotaSnapshot: null,
    }],
  },
};

const cliImported = { config: { githubHost: 'github.com', githubToken: '', credentialSource: 'copilot-cli' as const, user: { login: 'local-user', id: 123, name: 'Local User', avatar_url: '' } }, state: null };

vi.mock('../../../src/components/upstream-editor/config-sidebar', () => ({
  UpstreamConfigSidebar: ({ onPatch, record }: {
    onPatch: (patch: { config?: unknown; state?: unknown }, persisted: boolean) => void;
    record: UpstreamRecord;
  }) => {
    const { setValue, formState } = useFormContext<UpstreamEditorValues>();
    const patch = record.kind === 'copilot' ? cliImported : imported;
    return <>
      <button type="button" onClick={() => onPatch(patch, record.id !== '')}>Import credential</button>
      <button type="button" onClick={() => setValue('config', patch.config, { shouldDirty: true })}>Edit credential draft</button>
      {formState.errors.config?.message && <div>{i18n.t(String(formState.errors.config.message))}</div>}
    </>;
  },
}));

vi.mock('../../../src/components/upstream-editor/workspace', () => ({ UpstreamWorkspace: () => null }));

const blueprint = upstreamRecord('', { kind: 'codex', config: { accounts: [] }, state: { accounts: [] } });

const renderPage = (record: UpstreamRecord, mode: 'create' | 'edit') => {
  const router = createMemoryRouter([
    {
      path: '/editor',
      element: <OutcomeToastProvider><UpstreamEditorPage data={{
        mode, editLevel: 'full', record, discovered: null, proxies: [], runtime: { kind: 'node', runtimeLocation: 'TEST' },
      }} /></OutcomeToastProvider>,
    },
    { path: '/dashboard/providers/upstreams/:id', element: <div>Saved upstream</div> },
  ], { initialEntries: ['/editor'] });
  return renderInApp(<RouterProvider router={router} />);
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.create.mockResolvedValue({ data: { ...blueprint, id: 'up_codex', ...imported }, error: null });
});

test('creating a Copilot CLI upstream saves only the credential source and identity', async () => {
  const local = upstreamRecord('', { kind: 'copilot', config: { githubHost: 'github.com', githubToken: '', user: { login: '', id: 0, name: null, avatar_url: '' } }, state: null });
  apiMocks.create.mockResolvedValue({ data: { ...local, id: 'up_local', ...cliImported } });
  renderPage(local, 'create');
  fireEvent.click(screen.getByRole('button', { name: 'Import credential' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.actions.save') }));
  await waitFor(() => expect(apiMocks.create).toHaveBeenCalledWith({ json: expect.objectContaining({ kind: 'copilot', config: cliImported.config, state: null }) }));
});

test('an unverified Copilot CLI account cannot be saved', async () => {
  const local = upstreamRecord('', { kind: 'copilot', config: { githubHost: 'github.com', githubToken: '', credentialSource: 'copilot-cli', user: { login: '', id: 0, name: null, avatar_url: '' } }, state: null });
  renderPage(local, 'create');
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.actions.save') }));
  expect(await screen.findByText(i18n.t('dashboard.upstreamEditor.copilot.local.verifyRequired'))).toBeTruthy();
  expect(apiMocks.create).not.toHaveBeenCalled();
});

test('creating a Codex upstream saves the imported credential', async () => {
  renderPage(blueprint, 'create');
  fireEvent.click(screen.getByRole('button', { name: 'Import credential' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.actions.save') }));

  await waitFor(() => expect(apiMocks.create).toHaveBeenCalledWith({
    json: expect.objectContaining({
      kind: 'codex',
      config: imported.config,
      state: imported.state,
    }),
  }));
  expect(screen.queryByText(i18n.t('dashboard.upstreamEditor.fetchDirty.unsavedCredential'))).toBeNull();
});

test('editing a saved Codex upstream still rejects unsaved credential changes', async () => {
  renderPage({ ...blueprint, id: 'up_codex' }, 'edit');
  fireEvent.click(screen.getByRole('button', { name: 'Edit credential draft' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.actions.save') }));

  expect(await screen.findByText(i18n.t('dashboard.upstreamEditor.fetchDirty.unsavedCredential'))).toBeTruthy();
  expect(apiMocks.patch).not.toHaveBeenCalled();
});
