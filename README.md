<div align="center">

<img src="https://raw.githubusercontent.com/polystree/openag/main/resources/icon.png" alt="OpenAG Logo" width="96" height="96" />

# OpenAG

### Automatic multi-account quota pool and switcher for Google Antigravity

[![Open VSX](https://img.shields.io/badge/Open_VSX-v1.1.0-fa6400?style=flat-square&logo=eclipseide&logoColor=white)](https://open-vsx.org/extension/polystree/openag)
[![License](https://img.shields.io/badge/License-MIT-00b4d8?style=flat-square)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-Support_this_project-ff69b4?style=flat-square&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/polystree)

<p>OpenAG pools multiple Google accounts and automatically switches to whichever account has the most quota left, with no external tools or proxies required and feels native.</p>

<img src="https://raw.githubusercontent.com/polystree/openag/main/resources/ss.jpg" alt="OpenAG Interface" width="480" />

</div>

---

## What It Does

- **Auto Account Switching**: Automatically routes to the account with the highest available quota.
- **Auto-Run Terminal Fix**: Fixes Antigravity's "Always Proceed" terminal policy so commands execute automatically without asking to confirm every time.
- **Status Bar HUD**: See your active account, remaining quota, reset timers, and context usage at a glance.
- **Easy Account Pool**: Add your Google accounts once and let OpenAG handle the rotation in the background.
- **Secure by Default**: All tokens are safely stored in your system's secure keychain.

---

## Quick Start

1. Open the **OpenAG** tab in the sidebar.
2. Your currently signed-in Google account is added automatically.
3. Click **+ Add** to sign in with additional accounts in your browser.
4. Keep coding as usual, and OpenAG will automatically swap accounts for you to the one with the most quota left.

You can also click the status bar item anytime to see detailed quotas or switch accounts manually.

---

## Commands

- `OpenAG: Open Management Panel`: Open the sidebar view.
- `OpenAG: Add Google Account`: Add another Google account.
- `OpenAG: Switch Active Account`: Pick an account manually from the list.
- `OpenAG: Refresh All Quotas`: Update quota balances immediately.
- `OpenAG: Apply Auto-Run Terminal Fix`: Patch Antigravity terminal auto-execution.
- `OpenAG: Revert Auto-Run Terminal Fix`: Restore original Antigravity files.
- `OpenAG: Enable / Disable Extension`: Turn automatic management on or off.

---

## Build & Development

```bash
# Install dependencies
bun install

# Type check
bun run typecheck

# Lint with Oxlint
bun run lint

# Compile production bundle
bun run compile:prod

# Package VSIX extension
bun run package
```

---

## License

[MIT License](LICENSE) © **Polystree**


