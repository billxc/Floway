# Node-local Copilot CLI credentials

Floway on Node can create a GitHub Copilot upstream from an account already
signed in to the local Copilot CLI. The upstream stores only the selected
account and `credentialSource: "copilot-cli"`, never a copy of the CLI token.

## Add an upstream in the dashboard

1. Sign in with `copilot login` as the OS user running Floway.
2. Open **Providers → Upstreams → New upstream → GitHub Copilot**.
3. Select **Use local Copilot CLI** under **Authentication method**.
4. Pick a signed-in GitHub account and click **Verify and connect**.
5. Confirm the verified account and available models, then click **Save**.

Floway discovers the installed CLI runtime under `~/.copilot/pkg/<platform>/`
automatically (or under `$COPILOT_HOME`). Set `FLOWAY_COPILOT_CLI_RUNTIME_PATH`
to an absolute `runtime.node` path if the CLI is installed in a custom location.
Only `github.com` accounts are supported by this source.

## Credential lifetime

Each credential read runs in an isolated subprocess and transfers the token
over IPC with stdout and stderr disabled. Tokens are never written to the
Floway database or persisted in request dumps. CLI credentials authenticate
directly to `https://api.githubcopilot.com` with `copilot-integration-id: copilot-cli`.
