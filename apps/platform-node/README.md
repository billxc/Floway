# Node-local Copilot CLI credentials

Floway can use a locally signed-in Copilot CLI account instead of a Copilot
upstream's stored GitHub token. This is a Node-only, operator-controlled
credential source, not a credential import or a browser account picker.

## Configure a binding

1. Sign in with `copilot login` on the machine running Floway.
2. Select an existing Copilot upstream belonging to the same GitHub account.
3. Find the installed CLI's `prebuilds/<platform>/runtime.node` file. The reader
   uses the CLI's private `authGetTokenForAuthInfo` interface, verified with
   version `1.0.106-6`. Only use a CLI installation you trust: loading a native
   module executes its code with the Floway service user's permissions.
4. Set `FLOWAY_COPILOT_CLI_AUTH` before starting the Node service:

```sh
export FLOWAY_COPILOT_CLI_AUTH='{"up_example":{"login":"your-github-login","runtimePath":"/absolute/path/to/copilot/prebuilds/darwin-arm64/runtime.node"}}'
pnpm --filter @floway-dev/platform-node run start:built
```

Replace `up_example` with the upstream ID from the dashboard. Multiple upstream
bindings may be supplied in the same JSON object. The service must run as the
user who owns the CLI credential store. Custom CLI home directories, enterprise
`.ghe.com` hosts, and non-GitHub account types are not supported by this first
version. An invalid configuration fails startup. A bound upstream whose account
no longer matches the configured login fails before reading any credential.

The feature does not follow the CLI's default-account switch: it remains pinned
to the explicitly configured login. Updating a binding requires restarting
Floway. Unbound upstreams keep their existing authentication behavior.

## Authentication and credential lifetime

The reader starts an isolated child process for each credential read. It calls
the installed CLI's secret-store API and sends the token over IPC. Child stdout
and stderr are disabled; credentials are not placed in arguments, environment
variables, the Floway database, or request dumps. Existing stored upstream
credentials are neither removed nor replaced.

CLI OAuth credentials authenticate directly to `https://api.githubcopilot.com`
with the `copilot-cli` integration. They do not use the VS Code
`/copilot_internal/v2/token` exchange. Model listing, inference, and quota queries
use the selected source; requests still use the upstream's configured egress.

Floway reads the currently stored credential, but does not refresh or reauthorize
it. An unavailable CLI account or incompatible CLI runtime fails closed without
falling back to the stored upstream token. An upstream 401 is returned normally;
a later request rereads the credential. If the credential itself is invalid,
reauthorize with `copilot login`. Redirects are disabled for local-credential
requests.

## Verification

The package tests use synthetic credentials; they never require a local login
or contact GitHub. Tests cover account binding, IPC-only transfer, worker
compatibility failures, timeouts and aborts, direct authentication, quota
queries, and redaction before request-capture persistence.
