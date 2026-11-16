# Agents Bridge

Use **Claude Code** as the lead agent and hand work to **OpenAI Codex** and **Google Antigravity** as native background subagents. Claude delegates with its normal `Agent` tool; Codex and Antigravity run the job in your project folder and return the result. You can steer a running job, continue it later, or cancel it from Claude.

```text
                  you
                   |
             Claude Code  (lead agent)
              /          \
   codex:sol|luna|        codex:antigravity-gemini|default
   astra|terra            |
        |                 |
 codex app-server      agy acp  (official Antigravity CLI)
   (OpenAI Codex)         (Google Antigravity)
```

This repository is a Claude Code plugin (`codex@codex-full-access`) packaged as its own marketplace. It is a Windows-working, Antigravity-enabled fork of [ank1015/claude-codex-subagents](https://github.com/ank1015/claude-codex-subagents), itself a full-access fork of [SSS135/claude-code-codex-plugin](https://github.com/SSS135/claude-code-codex-plugin). MIT license and original copyright are preserved in `LICENSE`.

## What you get

| Agent (use this name in prompts) | Backend | Notes |
| --- | --- | --- |
| `codex:sol` | Codex `gpt-6.1-sol` | Default Codex agent: implementation, debugging, review. Effort high. |
| `codex:luna` | Codex `gpt-6-luna` | Cheap and fast for mechanical work. Effort max. |
| `codex:astra` | Codex `gpt-6-astra` | Only when you ask for it. Effort high. |
| `codex:terra` | Codex `gpt-5.6-terra` | Only when you ask for it. Effort high. |
| `codex:antigravity-gemini` | Antigravity via `agy acp` | Picks an advertised Gemini model. |
| `codex:antigravity-default` | Antigravity via `agy acp` | Keeps your account's default model. |

Also included: account-switch detection for Codex, automatic discovery of Codex and `agy`, the real model and effort shown in each task label, and an optional switch that makes jobs appear in the Codex Desktop app without restarting it.

> **Safety:** Codex jobs run with **full access and no approval prompts** (`danger-full-access`, `approvalPolicy: never`) as your operating-system user. Antigravity jobs **auto-approve** permission requests inside the job's folder and deny clearly outside paths; this is not an OS sandbox. Only use this in projects and on machines where that is acceptable.

## Quick start (Windows)

If you already have Node 18+, PowerShell 7, Git, Claude Code, Codex and the `agy` CLI installed and signed in:

```powershell
git clone https://github.com/Namans12/agents-bridge.git C:\Tools\agents-bridge
```

```powershell
claude plugin marketplace add "C:\Tools\agents-bridge"
```

```powershell
claude plugin install codex@codex-full-access
```

Start a new Claude session and try:

```text
Use codex:luna with effort: low to list the files in the current folder and say DONE. Do not modify anything.
```

Otherwise, follow the full step-by-step setup below.

## Full setup, step by step (Windows 10/11)

Run commands in PowerShell. Reopen the terminal after installing each tool so it sees the new PATH. Replace `<you>` with your Windows user name.

### Step 1. Install Node.js 18 or newer

```powershell
winget install --id OpenJS.NodeJS.LTS --exact
```

```powershell
node -v
```

### Step 2. Install PowerShell 7

The Windows bridge needs `pwsh` (PowerShell 7+) for its socket forwarder. Built-in Windows PowerShell 5.1 is not enough.

```powershell
winget install --id Microsoft.PowerShell --exact --source winget
```

```powershell
pwsh -NoProfile -Command '$PSVersionTable.PSVersion'
```

The major version must be 7 or higher. If `pwsh` is not on PATH, set `CODEX_BRIDGE_PWSH` to its full path (see Troubleshooting).

### Step 3. Install Git

```powershell
winget install --id Git.Git --exact
```

```powershell
git --version
```

### Step 4. Install and sign in to Claude Code

You need Claude Code **2.1.287 or newer** (this was built and tested on 2.1.296).

```powershell
irm https://claude.ai/install.ps1 | iex
```

```powershell
claude --version
```

```powershell
claude auth login
```

Do not launch Claude with `--safe-mode` or `--bare`, and make sure `disableAllHooks` is not enabled in your Claude settings; the plugin needs mods and hooks. Organization policy can also restrict them.

### Step 5. Install and sign in to Codex

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

Or, with npm:

```powershell
npm.cmd i -g @openai/codex
```

```powershell
codex --version
```

```powershell
codex login
```

```powershell
codex login status
```

You do **not** need to point the plugin at `codex.exe`: it finds the native executable itself, including the one behind npm's `codex.cmd` shim and the Codex Desktop app's install folder. You can use the Codex Desktop app and the CLI on the same login.

### Step 6. Install the Antigravity CLI (`agy`) and sign in

Antigravity's desktop app does not include the `agy` command; install the CLI separately. You need **agy 1.5.1 or newer**.

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

Open a new terminal, then:

```powershell
agy --version
```

```powershell
agy acp --help
```

Run `agy` once to sign in with your Google account. Inside it, open `/settings` and turn **Use AI Credits OFF** so jobs only use your subscription quota (the plugin cannot check this for you), and use `/credits` to confirm.

### Step 7. Clone this repository

```powershell
git clone https://github.com/Namans12/agents-bridge.git C:\Tools\agents-bridge
```

Keep this folder in place. Claude loads the plugin from it, and updates come from it.

### Step 8. Install the plugin

If you previously installed the upstream `codex@codex-full-access` plugin or another copy of this marketplace, remove it first so you do not run two copies:

```powershell
claude plugin uninstall codex@codex-full-access
```

```powershell
claude plugin marketplace remove codex-full-access
```

(These two commands report an error, harmlessly, if nothing was installed.) Then:

```powershell
claude plugin marketplace add "C:\Tools\agents-bridge"
```

```powershell
claude plugin install codex@codex-full-access
```

Claude prints `4 userConfig options not yet set`. That is normal: leave **Codex binary**, **Node binary** and **Antigravity binary** blank and **Default effort** as `per-model`. Fill a field only if auto-discovery fails (see Troubleshooting).

You can also add the marketplace straight from GitHub instead of a local clone:

```powershell
claude plugin marketplace add Namans12/agents-bridge
```

### Step 9. (Optional) Make Codex jobs appear in the Codex Desktop app

The Codex Desktop app keeps its own thread list and normally picks up jobs created by the plugin only when it restarts. This opt-in switch announces each job to the app after it starts and finishes, so the job appears within about 30 seconds with no restart and no window focus change. It needs the `@minhspark/codex-mcp-bridge` relay package installed and working, and it uses an internal, version-dependent app path, so it is off by default.

```powershell
[Environment]::SetEnvironmentVariable('CODEX_BRIDGE_DESKTOP_SYNC', '1', 'User')
```

Quit Claude completely (including its tray icon) and reopen it so it reads the new value. Turn it off by setting the same variable to `$null`. If a job's chat is open in the Codex app, Claude cannot continue that thread until you close it there.

### Step 10. Verify

From the cloned repository, run the setup check (it suppresses authentication output and starts no model turns):

```powershell
node scripts/check-setup.mjs
```

Start a **new** Claude session from your project folder (plugin changes are only read at startup) and run these test prompts one at a time.

Codex:

```text
Use codex:luna with effort: low to list the files in the current folder, write one sentence on what they are, then run `Start-Sleep -Seconds 20` and say DONE. Do not modify anything.
```

You should see a task titled like `[gpt-6-luna · low] ...`, then the result. Open the Codex Desktop app to see the chat (restart it, or use Step 9).

Antigravity:

```text
Use codex:antigravity-gemini to reply exactly ANTIGRAVITY_OK without using tools or changing files. Wait for its final result.
```

Check the installed version at any time:

```powershell
claude plugin list
```

In a Claude chat, ask it to run `codex_list` and `codex_result` to see jobs (including Antigravity jobs), their state and the full digest.

## Everyday use

- Codex: `Use codex:sol to implement X and run its tests.`
- Antigravity: `Use codex:antigravity-gemini to review this module.`
- Steer or continue a job: ask Claude to send a follow-up (it uses `SendMessage`). A finished job can be continued on the same thread or session.
- Cancel: ask Claude to stop the task (`TaskStop`).
- Optional header lines (the first lines of the delegation prompt): `effort: low|medium|high|xhigh|max|ultra` for Codex; `model:`, `effort:`, `mode:` and `cwd:` for Antigravity (values must be ones your account advertises).
- Project effort override: create `.claude\codex.json` in your project containing `{ "effort": "medium" }`.
- If you switch Codex accounts, the plugin notices the changed login and restarts its private Codex server the next time it is idle, so new jobs use the new account. A running job is never interrupted. Changing `CODEX_HOME` or environment-based credentials needs a Claude relaunch.

## Updating

```powershell
git -C C:\Tools\agents-bridge pull
```

```powershell
claude plugin marketplace update codex-full-access
```

Claude only refreshes an installed plugin when the `version` in `.claude-plugin/plugin.json` changes. If the pull brings a new version, reinstall:

```powershell
claude plugin uninstall codex@codex-full-access
```

```powershell
claude plugin install codex@codex-full-access
```

Check `%USERPROFILE%\.claude\plugins\cache\codex-full-access\codex\` for the version folder you expect, then start a new session. If you edit the plugin yourself, bump the version first.

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

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `codex bridge failed ... spawn codex ENOENT` | You are running an old copy of the plugin (cache version older than the repo) or discovery failed. Reinstall (Step 8). To force a path, set **Codex binary** to a native `codex.exe`, for example `C:\Users\<you>\AppData\Local\OpenAI\Codex\bin\<hash>\codex.exe` (the `<hash>` folder changes when Codex updates). `codex.cmd` and `.ps1` shims cannot be used directly. |
| Plugin installed but no `codex:*` agents | Start a **new** session; check `claude plugin list`; make sure mods and hooks are not disabled; make sure only one `codex` plugin copy is enabled. |
| `pwsh` not found, bridge will not start | Install PowerShell 7 (Step 2), or set `CODEX_BRIDGE_PWSH` to the full path of `pwsh.exe` before starting Claude. |
| Antigravity: `agy` not found or too old | Install the CLI (Step 6); it must be 1.5.1 or newer. Or set **Antigravity binary** to the full path of `agy`. |
| Antigravity: not signed in or quota error | Run `agy` once and sign in. Quota errors end the job without retry or paid fallback; keep **Use AI Credits** off unless you want overage. |
| Jobs are missing from the Codex Desktop sidebar | Restart the Codex app, or enable Step 9. You can also open a job directly: `Start-Process 'codex://threads/<thread-id>'`. |
| A wait call shows "Tool execution was interrupted" or "1 failed" | A known display quirk: the job keeps running. Check `codex_list` and `codex_result`. |
| `claude plugin test .` shows failures on Windows | The root suite has 5 known Windows path-fixture failures; see the reference. |
| Context is large at the start of a chat | This plugin costs only about 2k tokens. Most of the rest comes from other plugins, connectors and skills; disable the ones you do not use. |

More detail, internals and edge cases are in [docs/REFERENCE.md](docs/REFERENCE.md).

## Validation

```powershell
claude plugin validate .
```

```powershell
node --test tests/*.test.mjs
```

Windows validation for this release: 83 Node tests pass (original baseline: 38), and the root mod suite (`claude plugin test .`) has 29 passing tests plus 5 known Unix-path fixture failures. Antigravity is tested against a fake ACP server (`tests/fixtures/fake-agy.mjs`); real `agy` behavior depends on your account and version.

## Notes and limits

- Antigravity: Google documents third-party clients launching `agy acp`, but its Terms do not explicitly cover orchestrating it from Claude Code. The plugin only launches the official `agy` command and never reads or reuses your Antigravity login or calls private endpoints. Review Google's Terms for your account.
- The Claude task panel still counts wrapper usage, not Codex's or Antigravity's work. Read `codex_list` and `codex_result` for the real figures.
- The Codex Desktop refresh uses internal, version-dependent app behavior and may stop working after an app update.
- Antigravity jobs cannot message Claude mid-task, and Antigravity's own window is not synchronized.
- Each Claude session keeps at most 40 jobs; final messages are capped at 20,000 characters.

## Credits and license

Based on [SSS135/claude-code-codex-plugin](https://github.com/SSS135/claude-code-codex-plugin) (MIT) and [ank1015/claude-codex-subagents](https://github.com/ank1015/claude-codex-subagents). See `LICENSE`.
