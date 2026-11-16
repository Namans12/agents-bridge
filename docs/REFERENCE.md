# Agents Bridge: full reference (Windows/macOS setup, internals, troubleshooting)

Full-access fork of [SSS135/claude-code-codex-plugin](https://github.com/SSS135/claude-code-codex-plugin), based on version 0.2.3, commit `229137b3a8f6c21bbea653387f0e9ba909214b81`. Original copyright and MIT license are preserved.

Claude delegates through its native `Agent` tool to `codex:sol`, `codex:luna`, `codex:astra`, or `codex:terra`. Codex runs the task through `codex app-server`, while a native background subagent provides the task list entry, completion notification, messaging, and cancellation. Google Antigravity is also available through `codex:antigravity-gemini` and `codex:antigravity-default`, backed by Google's official `agy acp` subprocess.

## Fixed execution policy

Every Codex thread, resumed Codex thread, and follow-up Codex turn uses:

```json
{
  "sandbox": "danger-full-access",
  "approvalPolicy": "never",
  "approvalsReviewer": "user"
}
```

The turn-level equivalent is `sandboxPolicy: { "type": "dangerFullAccess" }`. There is no Codex sandbox and no approval reviewer is invoked for command escalation. Codex acts with the permissions of the operating-system account running it.

This policy is enforced, not merely a default. Old `sandbox:` and `approvals:` prompt headers are validated and stripped for compatibility but cannot change it. Old project or installed plugin permission settings cannot change it either. Existing saved jobs are normalized to full access when restored. An unexpected approval request is declined without a dialog; the plugin does not bypass a restriction imposed by the Codex server or managed configuration.

## Requirements

- Windows 10/11 with native Unix-domain socket support (introduced in Windows 10 1803); use an updated Windows installation. Windows 11 transport was verified for this package. [Microsoft's Windows 10 notes](https://devblogs.microsoft.com/commandline/windows10v1803/).
- Node.js 18+ on the machine running Claude Code. Install a current LTS release for a new setup.
- Claude Code CLI 2.1.287+ with mods enabled. Mods are on by default in these versions; `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is obsolete. [Claude mods documentation](https://code.claude.com/docs/en/plugins/mods/overview).
- For Codex delegation: authenticated Codex CLI with `codex app-server --listen stdio://`. On Windows, the bridge automatically finds a native `codex.exe`, including the executable behind an npm launcher.
- For Antigravity delegation: Google's official `agy` CLI **1.5.1 or newer**, signed in through its own Google login. Desktop/IDE installation alone does not supply this CLI. See [Antigravity delegation](#antigravity-delegation).
- **PowerShell 7 (`pwsh.exe`) on Windows**, for the socket forwarder. Built-in Windows PowerShell 5.1 is insufficient. PowerShell 7 supplies its own .NET runtime.
- Git for Windows is optional for ZIP installation; it is needed for cloning and Git-backed marketplaces.

macOS/Linux use a Unix socket directly and require no PowerShell forwarder. This release received static review plus simulated darwin/arm64 and Linux tests on Windows; no actual macOS/Linux process, IPC, Keychain or live model run has been performed. The owner must run the self-check and smoke prompts on a real Mac. WSL uses the Linux branch when Claude, Node and Codex all run inside WSL.

## Windows setup, step by step

Run commands in PowerShell unless a block explicitly says `cmd`. Replace `<you>` and example paths with your own values. Reopen your terminal after installing tools so it sees the updated PATH.

### 1. Install and check prerequisites

Install Node.js LTS through WinGet, or use the Windows installer from [nodejs.org](https://nodejs.org/en/download):

```powershell
winget install --id OpenJS.NodeJS.LTS --exact
```

```powershell
node -v
```

```powershell
npm.cmd --version
```

Install [PowerShell 7](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows):

```powershell
winget install --id Microsoft.PowerShell --exact --source winget
```

```powershell
pwsh -NoProfile -Command '$PSVersionTable.PSVersion'
```

The major version must be 7 or later. Keep `pwsh` on PATH, or set `CODEX_BRIDGE_PWSH` to its full executable path before starting Claude (see Troubleshooting).

For cloning or a GitHub marketplace, install [Git for Windows](https://git-scm.com/download/win):

```powershell
winget install --id Git.Git --exact
```

```powershell
git --version
```

Install Claude Code using its [official Windows installer](https://code.claude.com/docs/en/setup):

```powershell
irm https://claude.ai/install.ps1 | iex
```

Alternatively, install through WinGet:

```powershell
winget install --id Anthropic.ClaudeCode --exact
```

```powershell
claude --version
```

Require 2.1.287 or newer. Mods must be allowed: do not launch with `--safe-mode` or `--bare`, and check that `disableAllHooks` is not enabled in your Claude settings. Organization policy may also restrict mods.

Install Codex. The [official Codex installation guide](https://learn.chatgpt.com/docs/cli) provides a standalone Windows installer that avoids npm launcher issues:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

Or install the npm package:

```powershell
npm.cmd i -g @openai/codex
```

```powershell
codex --version
```

```powershell
codex app-server --help
```

The last command must show `app-server` and `--listen` support. It checks availability without starting a server. If PowerShell blocks the npm script, use `codex.cmd --version` and `codex.cmd app-server --help` for these terminal checks. The bridge unwraps standard npm launchers automatically; leave **Codex binary** blank for discovery (step 5).

### 2. Authenticate both CLIs

Sign in to Codex using the browser flow, then check that credentials are present. See [Codex login](https://learn.chatgpt.com/docs/developer-commands#codex-login).

```powershell
codex login
```

```powershell
codex login status
```

For an npm installation with a blocked PowerShell launcher, use `codex.cmd login` and `codex.cmd login status` instead.

```powershell
claude auth login
```

```powershell
claude auth status
```

Complete any first-run onboarding when you start Claude. Codex and Claude authenticate separately; installing the plugin does not sign you in.

### 3. Get the plugin: choose one option

**A. Provided Windows ZIP.** Extract `claude-codex-subagents-windows.zip` into a new folder:

```powershell
Expand-Archive -LiteralPath "C:\Users\<you>\Downloads\claude-codex-subagents-windows.zip" -DestinationPath "C:\Tools\claude-codex-subagents"
```

That folder must contain `.claude-plugin\plugin.json`, `hooks\`, and `bin\unix-forward.ps1` directly. For local ZIP uploads, `.claude-plugin/plugin.json` must be at the archive root, with no wrapping folder. The ZIP does not bundle Node, Codex, Antigravity CLI, or PowerShell.

**B. Clone the repository.** Install Git first:

```powershell
git clone https://github.com/Namans12/agents-bridge.git "C:\Tools\agents-bridge"
```

**C. GitHub marketplace.** Add the repository and install its plugin:

```powershell
claude plugin marketplace add Namans12/agents-bridge
```

```powershell
claude plugin install codex@codex-full-access
```

For B/C, the chosen repository revision must contain these Windows changes, including `bin/unix-forward.ps1`; a remote revision may differ from this local package. Use the fresh Windows ZIP if they have not been published. If present in a source download, the nested `codex-full-access/` directory and old `codex-full-access.zip` are stale pre-Windows copies. Use the root-level files.

### 4. Load it for one session, or install persistently

If an upstream copy is installed, follow step 8 to disable it before loading this fork. For one session, run this from the project you want Claude to work on:

```powershell
claude --plugin-dir "C:\Tools\claude-codex-subagents"
```

The same command in Command Prompt:

```cmd
claude --plugin-dir "C:\Users\<you>\Downloads\claude-codex-subagents"
```

`--plugin-dir` applies only to that session. For a persistent local installation, point the marketplace at the extracted or cloned plugin root:

```powershell
claude plugin marketplace add "C:\Tools\claude-codex-subagents"
```

```powershell
claude plugin install codex@codex-full-access
```

The local path and GitHub repository are alternative sources for the same `codex-full-access` marketplace; choose one. Keep a local marketplace folder in place. After configuring binaries below, start a new Claude session from your working project. Avoid loading a second copy through `--plugin-dir` when the installed copy is already enabled.

### Updating or replacing an installed copy

Claude runs an installed plugin from its own cache (`%USERPROFILE%\.claude\plugins\cache\codex-full-access\codex\<version>`), not from the folder you edited or extracted. A marketplace added from the upstream `ank1015/claude-codex-subagents` repository installs the upstream code, **not** the Windows, Antigravity and account-switching changes in this repository. If `plugin.json` keeps the same version, Claude will not refresh the cache. This repository ships version `0.2.4-fullaccess.6` for that reason.

To switch to the code in this ZIP, close every Claude session first, extract the ZIP to a permanent folder, then run:

```powershell
claude plugin uninstall codex@codex-full-access
```

```powershell
claude plugin marketplace remove codex-full-access
```

```powershell
claude plugin marketplace add "C:\Tools\claude-codex-subagents"
```

```powershell
claude plugin install codex@codex-full-access
```

Start a new Claude session and check that the cache folder is now `0.2.4-fullaccess.6` and contains `bin\antigravity.mjs`, `bin\resolve-agy.mjs`, `bin\resolve-codex.mjs` and `bin\auth-state.mjs`. Repeat these steps (with a new `version` in `plugin.json`) whenever you change the plugin.

### 5. Configure executable paths and project effort

**Leave the Codex binary field blank for automatic discovery.** Executable paths are Claude plugin options, not `.claude/codex.json` fields. The bridge launches Codex without a shell. On Windows it tries, in order:

1. An existing, valid **Codex binary** override.
2. Native `codex.exe` on Claude's PATH, preferring `.exe` over script launchers.
3. The native executable behind standard `codex.cmd` or `codex.ps1` npm launchers on PATH, including nested/hoisted optional platform packages and older bundled vendor layouts.
4. `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`, newest file modification time first.
5. The registered Codex Desktop Store package's `app\resources\codex.exe` (the CLI resource).

Each candidate must pass `--version` and `app-server --help` with `--listen` support, with a three-second timeout per check. Successful discovery is cached per process; a missing cached executable triggers discovery again on the next server start. A stale update/hash-directory override falls back automatically. When no candidate works, the error lists the paths/checks tried and how to fix the installation. Standard npm shims are inspected, never executed by the bridge.

On macOS/Linux discovery tries a configured path, inherited PATH and common absolute install directories (Apple Silicon `/opt/homebrew/bin`, `/usr/local/bin`, system bins, Linux Homebrew, `~/.local/bin`, `~/.npm-global/bin`, `~/.codex/bin`, and an absolute npm prefix from the environment). It then asks an installed npm for `prefix -g` without network access; Codex additionally probes `~/.codex/codex` and macOS app bundles under `/Applications` and `~/Applications`. Unix backend children receive these bin directories appended to PATH so npm shebang launchers can find Node. Node bootstrap tries its configured path, then `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`, `/bin/node`, then bare `node`. Hidden version managers can need an absolute override. Check Node with:

```powershell
Get-Command node.exe | Select-Object Name, Source
```

A manual Codex override remains available for custom installations. Use an absolute native executable path without embedded quotes; `<you>`, `%APPDATA%`, and `~` are not expanded in plugin options. For an installed plugin, an optional configuration file can contain:

```json
{
  "codexPath": "",
  "nodePath": "C:\\Program Files\\nodejs\\node.exe"
}
```

Save it through Claude's configuration command (use the location where you saved the file):

```powershell
Get-Content -Raw "C:\Tools\codex-plugin-options.json" | claude plugin configure codex@codex-full-access --values-stdin
```

For `--plugin-dir`, use Claude's `/config` panel to clear **Codex binary**, or set a manual override, then restart the session. Existing macOS manifest defaults can remain: missing overrides trigger discovery. You no longer need to find or enter a changing Desktop hash-directory path.

Optionally create `.claude\codex.json` in your **working project**, not the plugin installation directory:

```json
{ "effort": "medium" }
```

Only `effort` and legacy `sandbox`/`approvals` fields are read here. `codexPath` and `nodePath` in this file are ignored. Permissions remain fixed full access. The search checks the current directory first and then parents to the project root, but its parent traversal splits on `/` only; if Claude supplies backslash paths, parent discovery can be missed. Put the file in the session's current directory, or use the plugin's `defaultEffort` or a prompt `effort:` header.

### 6. Validate the installation

From the cloned plugin root, first run:

```powershell
node scripts/check-setup.mjs
```

It requests no model turns or login changes and suppresses all authentication output. WARN for a stale installed plugin version means refresh its cache; optional missing agy is also WARN. FAIL exits 1. Unix checks create and remove one temporary socket.

From the extracted/cloned plugin root:

```powershell
Set-Location "C:\Tools\claude-codex-subagents"
```

```powershell
claude plugin validate .
```

```powershell
claude plugin test .
```

```powershell
node --test tests/bridge.test.mjs
```

Validation should report `Validation passed`. The tests require no model calls or credentials. Run the Windows-compatible Node suites together:

```powershell
node --test tests/bridge.test.mjs tests/resolve-codex.test.mjs tests/auth-state.test.mjs tests/desktop-sync.test.mjs
```

The root mod suite has five known Windows failures from Unix/macOS path fixtures (before Antigravity: 25 pass, 5 fail; after: 29 pass, 5 fail). `claude plugin test .` in a source tree containing the stale nested copy also runs that copy's separate tests. The ZIP excludes it. Bridge fixtures explicitly run under Node and use the Windows named pipe, so the former `fake-codex ENOENT` failure is fixed.

The packaging check separately verified real Windows bridge startup with native `codex.exe`, named-pipe health, the PowerShell Unix-socket forwarder, and `codex-msg` mailbox delivery, without starting a model turn. Check the live Claude integration in step 7.

### 7. Start your first task

Return to your working project, then launch Claude with your chosen installation method. In Claude, open `/plugin` and check that `codex` is enabled and listed as an active mod. Ask:

```text
Use codex:sol to inspect this project and summarize its structure without changing files.
```

Then try a change: “Use codex:sol to implement the change and run its tests.” A native background task should appear. Ask Claude to call `codex_list` to see job IDs and states, then `codex_result` with the ID and `full: true` to read the result and digest. These are tools Claude calls, not shell commands or slash commands.

`SendMessage` steers a running turn or continues the same Codex thread after completion. `TaskStop` interrupts the Codex turn. Codex can send questions or interim findings through its `claude_session.message_claude` tool. Model/effort availability depends on your Codex installation and account.

### 8. Disable or uninstall the upstream copy

Do this **before the first task** if the upstream plugin is already installed. List installed plugins and identify its exact `codex@<marketplace>` ID:

```powershell
claude plugin list
```

```powershell
claude plugin disable "codex@<upstream-marketplace>"
```

Or remove it:

```powershell
claude plugin uninstall "codex@<upstream-marketplace>"
```

Replace the placeholder with the listed upstream marketplace, leaving `codex@codex-full-access` enabled. Restart Claude after changing installations. Enable one version of the `codex` plugin per session.

## macOS (Apple Silicon) setup, step by step

This release has a **static macOS/Linux review and simulated darwin/arm64 and Linux tests run on Windows**. A real Mac installation, Unix IPC, Keychain access, cancellation and live delegation are still pending owner verification. Run the self-check and both smoke prompts below on your Mac. No PowerShell is needed on macOS/Linux.

### 1. Check Xcode Command Line Tools and Homebrew

Use a native Terminal window on Apple Silicon (avoid running Terminal under Rosetta). Install Command Line Tools if needed, following [Homebrew's requirements](https://docs.brew.sh/Installation):

```bash
xcode-select --install
```

If macOS says the tools are already installed, continue. Check Homebrew:

```bash
brew --version
```

If missing, use the installer from the [Homebrew homepage](https://brew.sh/):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow the installer's printed shell setup instructions, then open a fresh Terminal. Apple Silicon Homebrew normally lives at `/opt/homebrew`.

### 2. Install Node and Git

Install [Node](https://formulae.brew.sh/formula/node) (18+ required) and [Git](https://formulae.brew.sh/formula/git):

```bash
brew install node
```

```bash
node --version
```

```bash
node -p 'process.platform + "/" + process.arch'
```

Expect `darwin/arm64`. An `x64` Node can run under Rosetta but is not the intended native setup; use `/opt/homebrew/bin/node` and a native Terminal.

```bash
brew install git
```

```bash
git --version
```

### 3. Install Claude Code and sign in

Use Anthropic's [official macOS installer](https://code.claude.com/docs/en/setup):

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Alternatively, choose its documented Homebrew cask:

```bash
brew install --cask claude-code
```

Open a new Terminal, then:

```bash
claude --version
```

Require **2.1.287+**. Start `claude` and complete onboarding/sign-in. Do not use `--safe-mode` or `--bare`; mods/hooks must be enabled, including under organization policy.

### 4. Install Codex and sign in

Choose **one** method from the [official Codex CLI guide](https://learn.chatgpt.com/docs/cli):

Homebrew:

```bash
brew install --cask codex
```

Or npm:

```bash
npm install -g @openai/codex
```

Or the standalone macOS/Linux installer:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Open a new Terminal and verify/sign in using [Codex authentication](https://learn.chatgpt.com/docs/auth):

```bash
codex --version
```

```bash
codex login
```

```bash
codex login status
```

The plugin can also probe `/Applications/Codex.app/Contents/Resources/codex`, the [documented desktop compatibility binary](https://learn.chatgpt.com/docs/reference/troubleshooting#feature-is-working-in-the-codex-cli-but-not-in-the-chatgpt-desktop-app). Installing the CLI separately is easier to diagnose. Desktop and CLI versions can differ. App bundle resources can move, so each candidate must pass version and app-server capability checks.

### 5. Optional: install Antigravity CLI (`agy`)

Google's [official macOS/Linux CLI instructions](https://antigravity.google/docs/getting-started?tab=cli) install `~/.local/bin/agy`:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Open a fresh Terminal:

```bash
agy --version
```

Require **1.5.1+** with ACP support. Check the CLI, then start it to complete its own sign-in:

```bash
agy acp --help
```

```bash
agy
```

In `agy`, turn **Use AI Credits OFF** in `/settings` and inspect `/credits` if available for your account/version. The plugin cannot verify that interactive setting. The desktop/IDE launcher alone does not supply the CLI.

### 6. Clone and install the plugin

Keep this folder in place:

```bash
mkdir -p ~/Tools
```

```bash
git clone https://github.com/Namans12/agents-bridge.git ~/Tools/agents-bridge
```

```bash
cd ~/Tools/agents-bridge
```

If replacing another copy of `codex@codex-full-access`, uninstall it and remove its old marketplace first using the same commands as the Windows replacement flow. Otherwise:

```bash
claude plugin marketplace add ~/Tools/agents-bridge
```

```bash
claude plugin install codex@codex-full-access
```

Leave **Codex binary**, **Node binary** and **Antigravity binary** blank; leave **Default effort** at `per-model`. Unset options may retain the manifest defaults (legacy ChatGPT Codex path and Homebrew Node); missing paths fall back automatically. Discovery covers common Homebrew/system locations, `~/.local/bin`, npm prefixes, `~/.codex` and supported app bundle candidates. Custom Node/version-manager installations may need an absolute **Node binary** path. Do not put `~` or shell quotes in a manual plugin path.

### 7. Optional: project effort

In your working project (not this plugin folder), create `.claude/codex.json`:

```json
{ "effort": "medium" }
```

Only effort belongs here; binary overrides belong in plugin options. Codex's fixed full-access policy is unchanged.

### 8. Run the setup check and smoke prompts

From the cloned plugin folder:

```bash
node scripts/check-setup.mjs
```

The check prints PASS/WARN/FAIL and exits 1 for failures. It checks versions, the installed plugin version, discovery, login exit status, executable permission and a temporary local Unix socket. It suppresses authentication output, requests no model turns or login changes, and removes its socket probe. A terminal check cannot prove that a Finder-launched Claude inherited the same environment; test that launch separately.

Start a **new** Claude session in your working project. Try these separately:

```text
Use codex:luna with effort: low to list the files in the current folder, write one sentence on what they are, run `sleep 20`, and say DONE. Do not modify anything.
```

```text
Use codex:antigravity-gemini to reply exactly ANTIGRAVITY_OK without using tools or changing files. Wait for its final result.
```

For Codex, also try steering and cancelling the task from Claude while it sleeps. Check `codex_list` and `codex_result` for its actual state. The Antigravity prompt needs the optional CLI and login.

### 9. Update or switch accounts

```bash
git -C ~/Tools/agents-bridge pull
```

```bash
claude plugin marketplace update codex-full-access
```

When the repository plugin version changes, refresh the installed copy:

```bash
claude plugin uninstall codex@codex-full-access
```

```bash
claude plugin install codex@codex-full-access
```

```bash
claude plugin list
```

Run the self-check again and start a new session. For tool updates use the same installation method: the Codex standalone installer or npm command above, `brew upgrade --cask codex`, and Anthropic's documented `claude update` for native installs or `brew upgrade claude-code` for Homebrew installs.

To switch Codex accounts, finish existing jobs, sign out/in with the Codex CLI in the same `CODEX_HOME`, then delegate again. File changes are detected at idle. [Explicit Keychain/non-file credentials](https://learn.chatgpt.com/docs/auth#credential-storage) cause conservative server reloads at idle boundaries; a new job waits while another Codex turn runs. Changing `CODEX_HOME` or environment credentials requires fully quitting and relaunching Claude. A browser-only account change does not switch local credentials. `ephemeral` credentials owned only by another process cannot be inherited.

### macOS troubleshooting

| Symptom | Fix |
| --- | --- |
| Works in Terminal, fails when Claude opens from Finder | GUI apps need not inherit shell PATH. Discovery probes absolute Homebrew/system/local paths. Fully quit/reopen Claude after installation. For a custom Node install, set **Node binary** to its absolute executable; use **Codex binary**/**Antigravity binary** for custom backend paths. Try launching Claude from the configured Terminal to compare environments. |
| npm install works but the plugin cannot find it | Use `npm prefix -g`; on Unix its executables are under `<prefix>/bin` ([npm folder layout](https://docs.npmjs.com/cli/v11/configuring-npm/folders/)). The resolver asks an installed npm for its global prefix offline and honors `npm_config_prefix`/`NPM_CONFIG_PREFIX`. A hidden version manager or custom prefix may still need an absolute override or matching PATH. |
| Downloaded binary is blocked/quarantined | Reinstall from the official source and follow [Apple's Privacy & Security guidance](https://support.apple.com/en-ph/102445). `xattr` can inspect downloaded-file metadata on the Mac; do not recursively clear quarantine from apps or your home directory. The checker never changes quarantine. |
| `bad CPU type`, Rosetta, or Node reports `x64` | Use a native Terminal and Apple Silicon Homebrew at `/opt/homebrew`; set **Node binary** to `/opt/homebrew/bin/node`. Reinstall platform-specific npm packages under that Node if needed. The resolver validates binaries by running them, rather than guessing their architecture. |
| Keychain permission prompt / old Codex account | Allow the official CLI access through the OS prompt as appropriate; run `codex login` yourself. Finish running turns before the next job reloads the account. No credentials or Keychain items are copied by the plugin. Managed credential settings plus a leftover auth file may hide a switch; if unsure, finish jobs and relaunch Claude after switching. |
| Unix socket path too long | Production uses `/tmp/cxb-<uid>/<16-character-session>-<8-character-build>/s`, independent of `$TMPDIR` and project path. The checker measures UTF-8 bytes against Darwin's 104-byte capacity (reserving NUL). If an error names a long `/var/folders/...` path, check for an older plugin/cache or another tool's socket. `/tmp` resolving to `/private/tmp` still leaves ample room. |
| `bin/codex-msg` is not executable | In the clone, run `chmod +x bin/codex-msg`. Git now records it as executable and `.gitattributes` enforces LF. Production launches it explicitly through Node, so messaging does not depend on the shebang permission. |
| Desktop sidebar does not refresh | The optional `CODEX_BRIDGE_DESKTOP_SYNC` relay integration is Windows-only. Read results in Claude; restarting Desktop may discover completed saved threads. |

**Unverified on macOS:** real arm64 installation and subprocess/IPC behavior, GUI launch inheritance, Keychain interaction, cancellation of child processes, live model/account access and interactive AI Credits settings. The legacy `ChatGPT.app/Contents/Resources/codex-cli/bin/codex` manifest default and alternative `ChatGPT.app/Contents/Resources/codex` probe are compatibility heuristics, not current documented install paths. Official commands above were checked in documentation, not executed on a Mac. Linux likewise has static review and simulated tests only.

## Antigravity delegation

The same `codex` plugin can delegate to Google's unmodified official CLI through [ACP over stdio](https://antigravity.google/docs/cli/acp/). It never reads agy's credential files, extracts OAuth tokens, calls private Antigravity services, or substitutes Gemini CLI. Authentication stays inside `agy`. The optional Codex Desktop notifier remains Codex-specific; Antigravity GUI visibility is not promised.

Install the separate CLI yourself using [Google's installation instructions](https://antigravity.google/docs/getting-started). On Windows:

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

Reopen the terminal, then check and sign in using agy's own interactive flow:

```powershell
agy --version
agy acp --help
agy
```

Require **agy >= 1.5.1**. The official installer supplies `%LOCALAPPDATA%\agy\bin\agy.exe`. Google also documents `agy acp --login` for terminal sign-in. Complete Google-account sign-in yourself; the plugin never initiates login. No CLI was installed or real Google model called during this integration's validation.

Before delegating, open `agy`, run `/settings` (or `/config`), and set **Use AI Credits = off**. Confirm the active account and inspect `/credits` and model quotas in agy's UI. Keep account overage/credit fallback disabled. Google documents `useG1Credits` as the setting controlling personal-credit fallback in its [CLI credits guide](https://antigravity.google/docs/cli/credits/).

The bridge removes `GEMINI_API_KEY*`, `GOOGLE_API_KEY*`, `GOOGLE_CLOUD_API_KEY*`, `GOOGLE_GENAI_USE_*`, `AGY_ADC_AUTH`, Application Default Credentials and common Vertex/project environment selectors from agy's child environment, including discovery probes. It does not select an API-key/enterprise authentication method. If ACP advertises the documented `useG1Credits` setting, the adapter sets it to false/off and verifies the returned value. The current docs expose no ACP-specific credit flag and do not promise that this setting is advertised. If absent, the job digest explicitly tells you to keep **Use AI Credits off** in agy; the plugin cannot verify your account settings without reading them. A previously configured API/enterprise profile must be switched to the intended Google subscription in agy's own UI. Quota, rate-limit, and credit-exhaustion errors end the job with an explicit error; the plugin does not retry or request paid fallback.

### Agent names, options, and prompts

| Native Agent type | Selection |
| --- | --- |
| `codex:antigravity-gemini` | Recommended default. Keep the currently selected Gemini model if available; otherwise select the first Gemini option advertised by the signed-in account. |
| `codex:antigravity-default` | Keep agy's current account model, including a non-Gemini model if offered. |

Claude namespaces registered agents under the plugin name, so these names begin with `codex:`. No `antigravity:gemini` input rewrite is installed. The small alias table lives in `hooks/model.ts`. Actual account-specific model IDs are discovered through ACP `configOptions`; the plugin does not invent fixed per-model aliases. To select another available model, use a `model:` header with its exact advertised ID. An invalid selection lists available IDs. `effort:` selects an advertised thinking-level ID or label; `mode:` selects an advertised execution mode. There is no inherited Codex effort policy for Antigravity. Unsupported choices fail before a wrapper starts.

**Antigravity binary** (`agyPath`) is an optional plugin userConfig string, blank by default. Discovery checks a valid manual override, native PATH entries before PATHEXT-aware CMD/PowerShell shims, then the documented install directory. Candidates must pass timed `--version` and `acp --help` checks; results are cached for one minute and rediscovered if missing. Native `agy.exe` is preferred. Custom `.cmd`/`.bat` shims use explicitly quoted `cmd.exe /d /s /v:off /c`; unsafe shell metacharacters are rejected. `.ps1` uses Windows PowerShell `-File` with an argument array. The official Windows installer is native and needs neither shim.

Use Claude's `/config` panel or `claude plugin configure codex@codex-full-access --values-stdin` as in step 5. Example options:

```json
{ "agyPath": "C:\\Users\\<you>\\AppData\\Local\\agy\\bin\\agy.exe" }
```

Start from the Claude project folder:

```text
Use codex:antigravity-gemini to inspect this project and summarize its structure without changing files.
```

Optional leading delegation-prompt headers (only advertised model/mode/effort values are accepted):

```text
cwd: C:\Projects\example
mode: plan
effort: High

Inspect this project and report your findings.
```

The default cwd is Claude's project cwd; `cwd:` may override it with an absolute path. A native background task appears with a `[resolved-model · thinking-level-or-mode]` description. The wrapper makes no Claude model requests and returns the streamed Antigravity message text when `session/prompt` ends. The parent Claude conversation still uses Claude quota.

### Permissions and job lifecycle

**Antigravity jobs can edit files and run commands in the project folder without prompting.** `ANTIGRAVITY_PERMISSION_POLICY = 'allow-once-within-cwd'` in `bin/antigravity.mjs` governs ACP callbacks. It chooses the advertised allow-once option (otherwise an allow option) for paths inside the job cwd or requests with no path. Clearly outside paths are denied, including traversal, sibling-directory prefixes, known command targets, and symlink/junction escapes. Denials appear in the digest and final output. Set `ANTIGRAVITY_DENY_PERMISSIONS=1` before launching Claude to deny all callbacks instead.

This callback policy is not an OS sandbox. Agy's existing rules can allow actions without a callback, and commands without declared targets cannot be fully analyzed. The plugin passes no `--dangerously-skip-permissions` flag; review agy's own rules and supervise work accordingly. Codex's fixed full-access policy is unchanged.

- Start with the native Agent types above. `codex_list` and `codex_result(id, full: true)` include both providers in the current Claude session; Antigravity rows identify their provider and do not claim Codex token usage.
- `SendMessage` to the agent ID/name sends another `session/prompt`, steering a running turn or continuing the same Antigravity session after completion.
- `TaskStop` sends `session/cancel`. A five-second cancellation deadline stops only that job's owned process tree if agy does not cooperate.
- One ACP child per job is owned by the existing bridge daemon, reusing its Windows named pipe/Unix-socket forwarder and reload grace period. This isolates cancellation and avoids duplicating IPC/lifecycle code. Completed children are released; a follow-up uses advertised `session/resume`, or `session/load` with replay suppressed. Persisted IDs remain scoped to `agents:<Claude session id>`. A restart interrupts a lost active turn; it is never automatically replayed. A subsequent SendMessage resumes the saved session.
- `/clear` or switching sessions stops the prior session's bridge. Process exit closes owned children; an unchanged-session plugin reload can reattach to its daemon. Setup has a 20-second overall deadline, prompt inactivity a 15-minute deadline.

Antigravity-to-Claude mid-task messaging and interactive elicitation forms are not implemented. Send all necessary context in the task; use SendMessage for follow-up. Optional ACP client filesystem/terminal callbacks are not advertised; agy runs its own tools. GUI synchronization, real account model availability, login, and subscription charging remain unverified until you run the installed official CLI.

### Troubleshooting and verification

| Symptom | Action |
| --- | --- |
| agy not found | Install the separate official CLI, reopen Claude to inherit PATH, or set `agyPath`; desktop `agy-node.cmd` and IDE launchers are not the CLI. |
| agy too old / ACP unavailable | Update to >= 1.5.1 and confirm `agy acp --help`; discovery includes tried paths and failed checks. |
| Authentication required | Run `agy` yourself and sign in with the intended Google account, then retry. No credentials are read or copied by the plugin. |
| Quota/rate-limit/credits exhausted | Stop and wait for subscription quota to refresh; inspect agy's quota UI. Keep Use AI Credits off. There is no automatic retry. |
| No advertised Gemini/model/effort | Read the error's offered IDs; try `codex:antigravity-default`, or remove unsupported headers. |
| Permission denied outside cwd | Review the request in `codex_result` with `full: true`; delegate with the intended absolute cwd if a different project is required. |

The ACP wire fields were checked against the live [session setup](https://agentclientprotocol.com/protocol/v1/session-setup), [config options](https://agentclientprotocol.com/protocol/v1/session-config-options), [prompt lifecycle](https://agentclientprotocol.com/protocol/v1/prompt-turn), and [permission schemas](https://agentclientprotocol.com/protocol/v1/tool-calls). The [official 1.5.1 release](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.1) fixes ACP lifecycle/Windows issues and removes older client-specific model restrictions. The fake Node ACP fixture covers streaming/results, steering, cancellation and deadlines, permission decisions, errors, model configuration, credit-option handling, and resume/load. Real CMD/PS1 shim launches and two headless Claude 2.1.296 runs returned `FAKE_AGY_OK`, including SendMessage steering and a fresh-child resume of the same session. All 38 Node tests pass; root mod tests are 29 pass / 5 known Windows fixture failures. These validate orchestration, not Google's authenticated server or billing.

Google explicitly documents external clients launching [official `agy acp`](https://antigravity.google/docs/ide/extensions/acp). Its [Terms](https://antigravity.google/terms) also restrict third-party access and do not explicitly clear Claude Code orchestration. This integration keeps credentials within Google's CLI; it does not resolve that terms ambiguity. Check applicable Google/account-administrator terms before use.

Run all Windows-compatible Node tests:

```powershell
node --test tests/bridge.test.mjs tests/resolve-codex.test.mjs tests/auth-state.test.mjs tests/desktop-sync.test.mjs tests/resolve-agy.test.mjs tests/antigravity.test.mjs
```

## Switching Codex accounts

Switch accounts with your normal Codex CLI/Desktop sign-in workflow. The plugin never signs you in or out. Before every new thread, thread resume, or new turn, it compares SHA-256 digests of `auth.json` and `config.toml` under the inherited `CODEX_HOME` (default: `%USERPROFILE%\.codex`). It never parses or logs token contents. If credentials/configuration changed and the server is idle, it restarts only its private app-server, initializes it again, clears account-dependent caches, and reloads saved threads with their existing full-access and messaging settings. The next job uses the credentials available to the new server. Existing history is preserved; account/provider restrictions on resuming a thread still apply.

Running turns keep their current server and are never interrupted for an account switch. If a change is detected while a turn or server request is active, a new job returns a clear **wait for existing turns to finish, then retry** message. Steering and cancellation remain available. The plugin does not replay failed model turns or bypass authentication, subscription, model, or rate limits.

For `cli_auth_credentials_store = "keyring"`, `"auto"`, or `"ephemeral"`, or when `auth.json` is absent, no reliable file signal identifies a switch. The bridge conservatively reloads the server at each idle job boundary. New jobs wait via the same retry message while other turns run; this credential mode therefore serializes jobs. Ephemeral credentials owned only by another process cannot be inherited. See [Codex credential storage](https://learn.chatgpt.com/docs/auth#credential-storage) and [app-server authentication](https://learn.chatgpt.com/docs/app-server#auth-endpoints). A scratch-home check of the installed CLI confirmed that `account/read` with `refreshToken: false` could retain the old account after the auth file changed. The bridge uses a fresh private server to load the new credentials.

If you use per-account homes, set `$env:CODEX_HOME = 'C:\Users\<you>\.codex-account-b'` **before launching Claude**. A daemon is isolated by the inherited home and environment credentials. Changing an environment variable in another shell, the user environment, or Desktop cannot update an already-running Claude process: finish its turns, close Claude, and launch it with the new environment. Switching only a browser/ChatGPT login does not change local Codex credentials. API-key environment variables likewise require a new Claude process when changed. Optional Desktop sidebar sync also requires Desktop/relay to use the matching account.

## Seeing Codex jobs in the Codex Desktop app on Windows

Jobs are saved Codex threads: the plugin sends `thread/start` with `ephemeral: false`, then `thread/name/set`. Desktop runs a separate app-server and sidebar catalog. Notifications from the plugin's private stdio server do not reach Desktop, so a saved job can be absent from the sidebar while `codex resume` and `codex agents` already list it.

On the checked Store package `26.1007.2314.0` (Desktop runtime `0.162.0-alpha.17.2`, CLI `0.162.1`), Desktop's bundle updates its catalog on startup, explicit internal sync requests, and notifications from its own app-server. No session-directory or `session_index.jsonl` watcher was found in that catalog path. Its optional shared-daemon transport explicitly excludes Windows, and `codex app-server proxy` could not connect to a Desktop control socket. The plugin uses private stdio on every platform; the earlier Mac behavior does not prove that it shared Desktop's server.

### Optional sidebar discovery without restarting Desktop

This fork can announce each job's existing title through an **already installed and working** `@minhspark/codex-mcp-bridge` native Desktop relay (tested with version `1.22.0`). This calls Desktop's `set_thread_title` tool, which produces a notification on Desktop's own connection and triggers catalog discovery. It does not send another prompt or navigate to the chat. The plugin keeps its private execution server, full access, and `approvalPolicy: never`.

Enable it in the PowerShell terminal that launches Claude:

```powershell
$env:CODEX_BRIDGE_DESKTOP_SYNC = '1'
claude --plugin-dir 'C:\Tools\claude-codex-subagents'
```

To make it permanent for every Claude launch (including the Claude desktop app), set it as a user environment variable, then **fully quit and reopen Claude** (including its tray icon) so the new value is picked up:

```powershell
[Environment]::SetEnvironmentVariable('CODEX_BRIDGE_DESKTOP_SYNC', '1', 'User')
```

To turn it off again, set it to `$null` the same way.

Use your actual plugin directory. The helper looks under `%APPDATA%\npm\node_modules\@minhspark\codex-mcp-bridge`. If the package is elsewhere, also set its absolute package directory (not its `src` directory):

```powershell
$env:CODEX_BRIDGE_DESKTOP_RELAY_ROOT = 'C:\Users\<you>\AppData\Roaming\npm\node_modules\@minhspark\codex-mcp-bridge'
```

Desktop and its native relay must be running, with both account identities verifiable by that bridge. A hardened relay may require an allowed, exact saved project. This plugin does not install or configure the relay, change its project grants, or bypass its checks. The integration is opt-in because the native Desktop tool/relay API is internal and version dependent. A missing relay, signed-out account, rejected project, or timeout is nonfatal: jobs still run, and `daemon.log` records `desktop sync: ...`. Remove the variable or set it to `0` to disable it. macOS/Linux ignore it.

The bridge announces after naming a thread and again after a turn finishes. At completion it reads the saved title first, preserving a Desktop rename made during the turn. Announcements are asynchronous and ordered per thread. Verification used the actual modified Windows bridge and a tiny job: the thread was absent from a fresh catalog copy before naming and present with its title and completed history afterwards; Desktop was never restarted. The user also confirmed the first scratch chat appeared in the sidebar. Discovery can take several seconds while Desktop schedules its scan; allow about 30 seconds when checking.

This enables sidebar discovery while a job runs when Desktop accepts the initial announcement, and provides another discovery attempt on completion. **Live streaming of the private server's turn into Desktop is not provided.** Opening a running job can encounter `already has an active writer`; Desktop and the plugin cannot both own the thread. Read completed jobs in Desktop, and use Claude's `codex_list`/`codex_result` for live plugin status. If Desktop has a completed chat open, navigate away before continuing that same job from Claude; releasing Desktop's writer is controlled by the app.

### Open a completed job directly

Use its Codex thread UUID, not Claude's agent/job ID. Find the job's `id` and `thread_name` in `%USERPROFILE%\.codex\session_index.jsonl`. In PowerShell:

```powershell
Start-Process 'codex://threads/01a136d9-f29a-7f30-ab55-f35139af2697'
```

Replace the UUID for another job. Alternatively, press **Win+R**, paste `codex://threads/<UUID>`, and press **Enter**. This command was exercised once for **Live visibility test job**: Desktop successfully read and resumed its completed history without another prompt. It brought the main window into focus. Fresh catalog copies still lacked the row until a later native relay title announcement triggered a scan, so a deep link is a direct-opening workflow, not a reliable sidebar-refresh command. The plugin never opens these links automatically.

### Manual fallback when the relay is unavailable

Sidebar discovery for externally created threads remains a Desktop limitation without the optional native announcement. The user verified that a full Desktop restart discovered older plugin jobs:

1. Finish Desktop's running tasks, fully quit it (including its tray process), then reopen it from Start. Closing only a window can leave the process running. This plugin does not restart Desktop for you.
2. Choose **In one list** in **Chat sidebar options** or **Project sidebar options**, and expand **Show more** if needed. These labels were checked in the bundle; grouping alone is not a catalog refresh.
3. Optionally use **Add folder** for the actual delegation directory, then the chat's **Move to project** or **Pin chat** menu. Parent and child working directories are distinct; a saved project is not required for direct links or the tested non-hardened title announcement.

CLI fallback:

```powershell
codex resume --all --include-non-interactive --no-daemon
```

The resume picker and `codex agents` list saved jobs by name. Exit the picker with **Ctrl+C** to avoid resuming anything. On older CLIs, check `codex resume --help` and omit unsupported options. `codex agents` uses the CLI's daemon and is not the plugin's live-job monitor. The [app-server documentation](https://learn.chatgpt.com/docs/app-server) describes thread listing and transports, but exposes no public Desktop catalog-register/refresh RPC.

Do not edit Codex's SQLite databases or global state to register jobs. The investigation read SQLite backups only; neither Desktop state files nor its process lifecycle were manually changed. Optional notification tests: `node --test tests/desktop-sync.test.mjs`.


## Windows troubleshooting

| Symptom | What to check |
| --- | --- |
| PowerShell says scripts are disabled | For terminal npm commands, use `npm.cmd`/`codex.cmd`. The bridge starts its forwarder with `-ExecutionPolicy Bypass` for that child process; it does not change the machine policy. Organization policy can still block scripts or `Add-Type`. Use PowerShell 7 and resolve policy restrictions with your administrator. |
| `node`, `codex.cmd`, or `pwsh` is not found | Reopen the terminal and restart Claude after installation. Check `Get-Command node.exe, codex.cmd, pwsh.exe`. `npm.cmd prefix -g` shows the global npm directory, commonly `C:\Users\<you>\AppData\Roaming\npm`; add your actual directory to user PATH if needed. The bridge resolves standard npm launchers to their installed native executable; reinstall Codex if its optional platform package is missing. |
| Bridge fails with `ENOENT`, `EINVAL`, or `EFTYPE` | Clear **Codex binary** to enable discovery, reopen Claude after installing/updating Codex, and read the tried-path list. Standard npm shims are unwrapped automatically; a missing manual override falls back. Set a manual native executable only for a custom installation. Check Node separately with `Get-Command node.exe`. |
| Account changed while jobs run / keyring retry message | Finish or cancel current turns, then retry the new job. The plugin keeps running turns alive and reloads credentials when idle. |
| Old account, 401, or limits after switching | Confirm the login in the same `CODEX_HOME` as Claude. For another home or changed API-key environment, restart Claude from that environment. A browser-only account change is insufficient; actual account/model limits still apply. |
| Cannot start PowerShell 7 / `pwsh ENOENT` | Put `pwsh.exe` on PATH or set `CODEX_BRIDGE_PWSH` to an existing full path. The code selects bare `pwsh` before its hardcoded `C:\Program Files\PowerShell\7\pwsh.exe` candidate; that hardcoded fallback is currently unreachable. |
| Socket/pipe connection fails, or the daemon does not start in 30 seconds | Confirm `bin\unix-forward.ps1` exists, PowerShell 7 launches, and the temp directory is writable. Windows uses a local named pipe plus a local Unix socket; there is **no TCP listening port** to open or change. Read any `forwarder:` output or daemon log available before shutdown. A working pipe alone does not establish that the Unix-socket forwarder is ready. |
| Antivirus/firewall blocks startup | Check protection/quarantine logs for the actual Node, Codex, PowerShell, or forwarder failure. Local IPC needs no inbound network port rule. Codex still needs outbound access for authentication and inference. Restore/allow only the trusted components implicated by your security software. |
| Long paths or Unix socket path-length errors | Keep the plugin/project paths short. The socket path is under Node's `os.tmpdir()`, normally `%TEMP%`, and Unix socket paths have a shorter limit than ordinary files. For a confirmed socket path-length error, set `TEMP` and `TMP` to an existing short, writable, per-user directory before launching Claude. A Windows long-path setting alone does not increase the socket limit. |
| Node is too old or the wrong Node is selected | Check `node -v` and `Get-Command node.exe`; use Node 18+ and set the correct `nodePath`. A current LTS is preferred. The same resolved Node runs both the bridge and `codex-msg`. |
| Plugin is absent, or installed but agents/tools are absent | Check the plugin root/ZIP layout, `claude plugin validate .`, `/plugin`, and mods settings. Do not load the stale nested copy. Restart after installing/configuring, or use `/reload-plugins` for plugin changes. Run `claude --debug --plugin-dir "C:\Tools\claude-codex-subagents"` to inspect startup failures. |
| Claude version is too old | Check `claude --version`. For a native install use `claude update`; for WinGet use `winget upgrade --id Anthropic.ClaudeCode --exact`. Require 2.1.287+. |
| Project effort is ignored | Binary paths belong in plugin options. Put `.claude\codex.json` in the session's current directory if parent discovery fails on backslash paths, or set `defaultEffort`/a prompt header. |

Example PowerShell override, set in the terminal that will launch Claude:

```powershell
$env:CODEX_BRIDGE_PWSH = "C:\Program Files\PowerShell\7\pwsh.exe"
```

The Windows daemon directory is `<os.tmpdir()>\cxb-<sanitized-user>\<session-key>-<build-hash>`. It contains `pid`, `daemon.log`, `forward.ready`, and socket `s` while running. The named pipe uses the same user/session/build identity. Shutdown normally removes this directory, so the log may already be gone; the relay reports a log tail when it can still read one. The forwarder exits when the daemon closes its stdin.

## Models and effort

| Agent | Model | Default effort |
| --- | --- | --- |
| `codex:sol` | `gpt-6.1-sol` | high |
| `codex:luna` | `gpt-6-luna` | max |
| `codex:astra` | `gpt-6-astra` | high |
| `codex:terra` | `gpt-5.6-terra` | high |

Use an `effort:` header to override effort for one task. Otherwise the nearest `.claude/codex.json` effort wins over the plugin's `defaultEffort`, followed by the per-model default. Model and effort availability are checked through Codex's `model/list`.

```json
{ "effort": "medium" }
```

Claude's plugin configuration accepts `codexPath`, `agyPath`, `nodePath`, and `defaultEffort`. Missing overrides fall back automatically. On Windows, **Codex binary** can be blank: native PATH, npm, Desktop hash directories, and Store CLI resources are discovered as described in step 5.

## Fixes in this fork

- Saved registries use separate `agents:<Claude session id>` keys. Writes are serialized and use the latest state.
- Legacy registries migrate only jobs owned by the current session. The shared legacy key is left untouched for other sessions.
- Recovery, process-exit handling, result lookup, and the running-jobs display operate on the current session's jobs.
- `/clear`, `/resume`, and `/branch` reload saved state. Switching session identity shuts down the old bridge and clears its caches; stale relay events cannot mutate the replacement session.
- The wrapper's `turn.step` error handler ends with an explicit failure instead of making a Claude model request.
- Approval text helpers preserve complete command and permission details.
- Windows bridge processes listen on named pipes, with a PowerShell 7 Unix-socket forwarder for Claude Code; `codex-msg` connects directly to the pipe. Processes use `windowsHide`, and daemon files live under the user's temp directory instead of `/tmp`.

## Tools and limits

`codex_list` lists this session's latest 10 Codex and Antigravity jobs. `codex_result(id, full)` reads a job in this session; `full` includes its command/file/message digest. `codex_await` is internal to wrapper agents.

A job starts a new Codex thread; this does not import existing Codex conversations or custom agent roles. Codex receives the delegation prompt, its own configuration and project instructions, and the messaging instructions. It does not receive the Claude conversation automatically.

Wrapper agent definitions now name their Codex model (`gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-astra`, or `gpt-5.6-terra`) instead of Haiku. The plugin answers every wrapper model turn itself; it makes no Anthropic request for that model. Claude Code 2.1.296 accepted these full IDs and reported `gpt-6-luna` in subagent messages in a live Windows smoke test, including auto mode. There is no separate display-only model field. The Agent tool's optional `model` parameter accepts only Claude aliases, so the plugin leaves that parameter intact; an explicit override can still make the chip say Haiku or another Claude model. Desktop's exact chip rendering depends on its version and was not visually verified.

New task descriptions begin with the resolved settings, for example `[gpt-6.1-sol · high] Inspect project`; the terminal's running-job hint also shows model and effort. These labels reflect prompt/project effort overrides, independently of the native model chip. Start a **new Claude session or reload the plugin** to pick up the definitions; existing task entries keep their old metadata. Avoid a Claude `model` override when delegating to `codex:*`.

Claude Desktop’s task panel still counts wrapper usage and tool calls, not Codex's execution. Read `codex_list` or `codex_result` for Codex's reported token total; the plugin does not inject those cumulative thread totals into Claude's per-response usage or cost accounting. A pending `codex_await` has also been observed displaying as interrupted even though the same call later returned successfully; check `codex_list` and `codex_result` for the Codex job state. The parent Claude conversation still consumes Claude usage. Native auto-mode handback may show the classifier-unavailable note because Codex executes outside Claude's classifier. Final messages retain the upstream 20,000-character limit, digests retain 60 entries, and each session retains at most 40 jobs. Claude's plugin store has a shared 4 MiB limit. Very large outputs should be written to files by Codex.

The bridge owns an app-server process per Claude session/build. On macOS/Linux it serves HTTP over a private Unix socket. On Windows it serves HTTP over a named pipe, and `bin/unix-forward.ps1` exposes a real Unix socket for Claude Code's HTTP client. Node's relay and `codex-msg` use the pipe; Codex app-server communicates over stdin/stdout. No TCP listener is used. Native mod APIs and the Codex app-server protocol can change between versions.

The original implementation is credited to [SSS135](https://github.com/SSS135/claude-code-codex-plugin); this repository maintains the full-access and Windows changes. Original copyright and the [MIT license](LICENSE) are preserved.

## Validation

```powershell
claude plugin validate .
```

```powershell
claude plugin test .
```

```powershell
node --test tests/bridge.test.mjs
```

The plugin tests use a fake app server and exercise orchestration without model calls. The bridge test launches a real bridge process against a fake Codex executable. Neither requires credentials. See step 6 for the remaining mod-test Windows path-fixture failures; the Node suites are Windows-compatible. Live model and interactive UI behavior need a separate smoke test after loading the plugin.
