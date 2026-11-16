# macOS Apple Silicon review and verification

Reviewed on Windows on 2026-11-17. Base revision: `7ff0a0b67f9b19b7225a252d25b2bae087c77017`.

Runtime code changed, so the plugin version is **0.2.4-fullaccess.6** (previously `.5`). No push was performed. The owner's real Mac run is pending; simulated platform tests are not a macOS runtime certification.

## Findings

Locations below refer to the reviewed/fixed tree. REAL BUG rows describe the original defect and its fix.

| Classification | Location | Finding and disposition |
| --- | --- | --- |
| REAL BUG | `bin/resolve-codex.mjs:45–57` | POSIX discovery formerly stopped after configured path and inherited PATH. A Finder launch could miss Homebrew, local/npm installs and Desktop bundles. Added well-known absolute candidates, offline npm-prefix discovery and validated app resources. |
| REAL BUG | `hooks/register.tsx:220–228` | Blank Node configuration lost the manifest's Homebrew absolute path and fell straight to bare `node`. Added Homebrew/system Node fallback probes; custom hidden version managers still need an explicit path. |
| REAL BUG | `bin/resolve-agy.mjs:38–61` | PATH-less discovery only knew `~/.local/bin/agy`; alternate Homebrew/npm installs were missed. Added common Unix bins and npm-prefix discovery. Official local installer location remains supported. |
| REAL BUG | `bin/codex-msg:1` (Git mode) | Windows checkout had recorded the shebang entry point as 100644. Fixed Git mode to 100755. Production already invokes it as `node <script>` (`hooks/model.ts:495–496`), so ordinary messaging did not depend on its executable bit. No content change. |
| REAL BUG | `bin/bridge.mjs:133–136`, `bin/antigravity.mjs:82`, `bin/posix-paths.mjs:18–21` | A POSIX npm shebang launcher found by an absolute probe still needs Node in its child PATH. Resolver checks and backend subprocesses now append common bins and the running Node's directory, preserving inherited PATH order. Windows env is returned unchanged. |
| OK | `bin/bridge.mjs:573–601`, `bin/socket-paths.mjs:4–13` | Production already used `/tmp/cxb-<uid>/<bounded-key>-<8-hex-build>/s`, not macOS TMPDIR. Extracted identical layout as a pure helper. With a 10-digit UID and longest key, the socket is 47 bytes, below Darwin's 104-byte sun_path (including room for NUL); Linux is also covered. Long/multibyte TMPDIR and byte boundaries are tested. |
| OK | `.gitattributes:2–4`, `bin/codex-msg:1` | Shebang scripts use LF. Git mode audited; bridge, fixtures and messaging scripts are explicitly invoked through Node, and the Windows forwarder through PowerShell. No other production script is directly exec'd. |
| OK | `bin/antigravity.mjs:82–83,213–222`, `bin/bridge.mjs:611,654` | ACP children are POSIX process-group leaders (`detached: true`); `kill(-pid, SIGTERM)` targets that owned group. Launcher/daemon detach is intentional so reloads preserve jobs. The Codex child is not a group leader, so its existing direct PID termination must not be replaced by a negative-PID kill. |
| RISK | `bin/antigravity.mjs:213–222`, `bin/bridge.mjs:277–290` | POSIX cleanup relies on SIGTERM/cooperative children; stubborn or re-grouped descendants can outlive shutdown. No speculative lifecycle change was made without a Mac runtime. Owner should check cancellation and lingering processes with the smoke flow. |
| OK | `bin/auth-state.mjs:6–25`, `bin/bridge.mjs:313–350` | Explicit `keyring`, `auto`, `ephemeral`, or absent auth file causes conservative idle reload; busy turns are preserved and new jobs receive the retry message. Three additional fake-store tests cover a leftover auth file; existing bridge integration tests cover idle reload and busy refusal. Tokens are hashed, never logged. |
| RISK | `bin/auth-state.mjs:19–25` | This is a small top-level TOML/file signal, not a complete effective-config/Keychain query. Managed keyring settings plus a leftover auth file can hide a switch. Guide advises finishing jobs and relaunching Claude after switching if uncertain. No Keychain reads were added. |
| RISK | `.claude-plugin/plugin.json:16–26`, `README.md:511` | The legacy ChatGPT bundle default may not exist. Missing overrides fall back. Official docs verify the retained `/Applications/Codex.app/Contents/Resources/codex` binary; legacy/alternate ChatGPT resource probes are explicitly marked heuristics. Bundled CLI capability/version checks prevent selecting the GUI app. |
| OK | `bin/resolve-codex.mjs:58–114`, `bin/resolve-agy.mjs:11–23`, `bin/bridge.mjs:491–514`, `bin/desktop-sync.mjs:44` | Windows-only `.exe`, Store/npm shim, CMD/PowerShell, named-pipe/forwarder and relay code remains platform guarded. Full-access protocol policy and `hooks/model.ts` are unchanged byte-for-byte in Git. No Windows command-launch/permission logic was changed. |
| RISK | `bin/bridge.mjs:493–495` | Pre-existing Windows `pwsh` literal wins before the hardcoded Program Files candidate even if it is not on PATH. Kept unchanged per scope; use PATH or `CODEX_BRIDGE_PWSH`, as the reference already explains. |
| RISK | `README.md:498–511` | Gatekeeper, GUI environment, Rosetta, native package architecture, actual Keychain prompts and live account/model access need owner verification. Troubleshooting and a non-inference setup check provide the handoff. |

## Changes and locations

| Files / line ranges | Change |
| --- | --- |
| `bin/posix-paths.mjs:1–34`; `bin/resolve-codex.mjs:1,31–32,45–57`; `bin/resolve-agy.mjs:1,26,38–61` | Shared injectable Unix discovery, npm prefix and child PATH preparation. Each candidate still needs CLI version/capability checks. |
| `hooks/register.tsx:220–228`; `bin/antigravity.mjs:1,82`; `bin/bridge.mjs:48–49,72–73,133–136` | Node bootstrap fallback, backend environment use and daemon build hash dependencies. |
| `bin/socket-paths.mjs:1–13`; `bin/bridge.mjs:573–601` | Pure socket layout shared by runtime/tests/self-check; previous Windows and POSIX layout preserved. |
| `bin/codex-msg` | Mode-only 100644 → 100755; blob unchanged. |
| `scripts/check-setup.mjs:1–124` | Dependency-free cross-platform diagnostics with exported pure helpers and direct-execution guard. All auth subprocess output ignored, versions parsed before display. A temporary Unix socket is the sole intentional transient write and is removed. |
| `tests/posix-setup.test.mjs:1–113`; `tests/auth-state.test.mjs:36–44` | Fake darwin/arm64/Linux layouts, PATH-less Homebrew/local/npm/bundle discovery, npm-prefix validation, socket byte boundaries/unchanged Windows layout, check-script helpers and non-file auth stores. |
| `README.md:208–215,272–511,539`; `docs/REFERENCE.md:33,231,262–270,332–571` | Full numbered Mac guide, honest verification boundary, Windows checker steps, discovery details, version/update/account/troubleshooting notes. Fixed an existing control character in a Windows clone example. |
| `.claude-plugin/plugin.json:3,13,25` | Required runtime version bump and discovery help text. Defaults preserved. |

## Validation on Windows

| Command/check | Before | After |
| --- | --- | --- |
| `node --test tests/*.test.mjs` | 38 pass / 0 fail | **83 pass / 0 fail**, 0 skipped |
| `claude plugin validate .` | Pass | Pass |
| `claude plugin test .` | 29 pass / 5 fail | **29 pass / same 5 fail** |
| `node --check` on changed `.mjs` | — | Pass for all 9 files |
| `node scripts/check-setup.mjs` | — | **Exit 0**, 0 FAIL; stale installed `.5` vs repo `.6` warning |
| Git mode / LF / policy | — | `bin/codex-msg` is 100755, blob unchanged, LF confirmed; `hooks/model.ts` byte-for-byte unchanged |

The unchanged mod failures are: model registration effort fixture, exact-prompt spawn's Homebrew Node fixture, project config precedence, per-model effort precedence and userConfig effort precedence. All five reproduce on the original clone; Windows normalizes their Unix path fixtures differently. No regression is being hidden by that baseline.

Final changed-MJS syntax checks covered `bin/antigravity.mjs`, `bin/bridge.mjs`, `bin/posix-paths.mjs`, `bin/resolve-agy.mjs`, `bin/resolve-codex.mjs`, `bin/socket-paths.mjs`, `scripts/check-setup.mjs`, `tests/auth-state.test.mjs`, `tests/posix-setup.test.mjs`.

### Setup-check output

Only the local home-path prefix has been replaced with `%USERPROFILE%`; no authentication output was captured or displayed. The installed plugin was not upgraded or changed for this run.

```text
PASS Node: 22.22.2 (requires >= 18.0.0).
PASS Platform win32/x64; Node C:\Program Files\nodejs\node.exe.
PASS Claude Code: 2.1.296 (requires >= 2.1.287).
WARN Plugin version differs from repository 0.2.4-fullaccess.6, or multiple scopes exist; cache/source may be stale. Update the marketplace, uninstall/reinstall, then start a new Claude session.
PASS Codex %USERPROFILE%\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe; version 0.162.1.
PASS codex login status exit 0.
PASS Optional agy %USERPROFILE%\AppData\Local\agy\bin\agy.exe; version 1.5.1 (requires >= 1.5.1).
PASS PowerShell: 7.6.10 (requires >= 7.0.0).
PASS CODEX_BRIDGE_DESKTOP_SYNC is enabled (optional relay required); this feature is Windows-only.
PASS Setup check complete: 0 failing checks. No model turns or login changes were requested.
```

## Commands verified against official docs

Verification means documentation read on 2026-11-17, not execution on macOS. Repository clone/marketplace/test commands are this project's workflow; package installation commands below come from the linked official sources.

| Exact command / location | Official source |
| --- | --- |
| `xcode-select --install` | https://docs.brew.sh/Installation |
| `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` | https://brew.sh/ |
| `brew install node` | https://formulae.brew.sh/formula/node |
| `brew install git` | https://formulae.brew.sh/formula/git |
| `curl -fsSL https://claude.ai/install.sh \| bash`; `brew install --cask claude-code`; `claude update`; `brew upgrade claude-code` | https://code.claude.com/docs/en/setup |
| `brew install --cask codex`; `npm install -g @openai/codex`; `curl -fsSL https://chatgpt.com/codex/install.sh \| sh`; `brew upgrade --cask codex` | https://learn.chatgpt.com/docs/cli |
| `codex login`; `codex login status`; `codex logout` | https://learn.chatgpt.com/docs/auth |
| `/Applications/Codex.app/Contents/Resources/codex --version` | https://learn.chatgpt.com/docs/reference/troubleshooting#feature-is-working-in-the-codex-cli-but-not-in-the-chatgpt-desktop-app |
| `curl -fsSL https://antigravity.google/cli/install.sh \| bash`; `agy --version`; `agy` and `~/.local/bin/agy` | https://antigravity.google/docs/getting-started?tab=cli |
| `npm prefix -g`, with executables in `<prefix>/bin` on Unix | https://docs.npmjs.com/cli/v11/commands/npm-prefix and https://docs.npmjs.com/cli/v11/configuring-npm/folders/ |

### Unverified on macOS

Real Mac process creation, Unix IPC, cancellation, GUI PATH inheritance, Gatekeeper/quarantine handling, Keychain prompts, authentication/model access, and interactive AI Credits settings. Legacy ChatGPT app bundle locations and `~/.codex` binary locations are defensive candidates, not asserted official current installer destinations. No unverified macOS installer command was added. Apple quarantine troubleshooting links to https://support.apple.com/en-ph/102445; no quarantine-removal command is recommended. Linux also received static review/simulation only.

The owner should run the numbered guide, `node scripts/check-setup.mjs`, both delegation smoke prompts, and steering/cancellation from a real Apple Silicon Mac before publishing macOS support as runtime verified.
