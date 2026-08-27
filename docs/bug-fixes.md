# Bug Fixes

## 2026-08-27 - Remove intrusive global notification banners and anchor settings

- **Problem:** The application shell rendered a red alert summary and a yellow security warning above every route, while the settings entry stopped above a large unused area in the desktop sidebar.
- **Impact:** Repeated banners consumed workspace height and made route-level content feel blocked; settings was harder to find because it was not visually anchored to the sidebar corner.
- **Changed scope:** `ui/src/components/Layout.tsx` no longer mounts the two global banners; detailed notification and security information remains available on their dedicated pages. `ui/src/styles/layout.css` makes the desktop sidebar a full-height column and anchors the settings block to the lower-left corner without changing mobile drawer spacing.
- **Regression coverage:** Route content and the notification center remain available; mobile navigation keeps its existing drawer layout.
- **Verification:** `pnpm lint`, `pnpm build`, `git diff --check`; desktop and mobile browser screenshots of `/dashboard` and `/settings`.

## 2026-08-27 - Replace anthropomorphic navigation and status copy

- **Problem:** Several headings and navigation notes used slogan-like, anthropomorphic wording such as “帮你管住消息频率”“消息不会悄悄丢掉” and “AI 学会的东西”，which made operational pages feel informal and obscured the actual capabilities.
- **Impact:** Users had to infer whether a page controlled delivery, recorded state, or managed local assets; status messaging also made guarantees sound stronger than the displayed evidence.
- **Changed scope:** Updated navigation notes plus Dashboard, Gateway, Evolution, Settings, Skills, alert-banner, and empty-state copy to describe notification delivery, retained records, evaluation controls, and read-only assets directly.
- **Regression coverage:** Searched the UI source for the retired phrases and verified the updated headings/notes through the running browser DOM.
- **Verification:** `pnpm lint`, `pnpm build`, `git diff --check`; runtime validation against `http://127.0.0.1:17531/gateway`.

## 2026-08-27 - Dark theme contrast and legacy surface cleanup

- **Problem:** Dark mode still exposed historical light/purple styles on the Evolution preflight and ledger surfaces, and the dashboard recovery panel retained a light background. Labels, helper copy, status pills, refresh/disabled buttons, table rows, and the diagnostic heading therefore had poor contrast and inconsistent visual hierarchy.
- **Impact:** Users could miss preflight state and recovery guidance, while the dark theme looked visually fragmented and unfinished.
- **Changed scope:** `ui/src/styles/theme-overrides.css` now applies dark-only graphite tokens and semantic success/warning/error colors to Evolution states, checks, decision panels, gate forms, ledger tables, buttons, Ant Design alerts, and the dashboard `.recovery-panel`.
- **Regression coverage:** Existing light-theme rules remain unchanged; dark desktop screenshots were checked for `/evolution` and `/dashboard` after rebuilding the static bundle.
- **Verification:** `pnpm lint`, `pnpm build`, `git diff --check`; runtime validation against `http://127.0.0.1:17531/evolution` and `http://127.0.0.1:17531/dashboard` with dark color scheme.

## 2026-08-26 - Remove redundant global event ticker

- **Problem:** The bottom event ticker repeated status information already shown by page-level state, the alert banner, and the operation log while permanently consuming viewport height.
- **Impact:** The application workspace had less usable vertical space without adding a clear action or useful new context.
- **Changed scope:** `ui/src/components/Layout.tsx` no longer renders the global event ticker. Event-driven refreshes and page-level operation records are unchanged.
- **Regression coverage:** Navigation, alert banners, and page-level status components remain mounted in the application shell.
- **Verification:** `pnpm lint`, `pnpm build`, and desktop/mobile browser screenshots of `/settings` and `/skills`.

## 2026-08-26 - CI installer test writes to a protected absolute path

- **Problem:** The OpenClaw Compose validation test used `/repo` for `repoDir` and `overridePath`. The installer correctly creates the override directory, but GitHub Actions runners cannot create `/repo`, so the test failed with `EACCES` before it could validate the intended invalid Compose configuration.
- **Impact:** The TypeScript CI job failed and blocked every workflow run that executed the test suite.
- **Changed scope:** `packages/installer/tests/install.test.ts` now creates and removes its own writable temporary directory. `.github/workflows/ci.yml` upgrades `actions/checkout` from v4 to v5 to remove the Node 20 action-runtime deprecation warning.
- **Regression coverage:** The existing invalid merged-Compose test continues to assert that Compose validation fails and `docker compose up` is not invoked.
- **Verification:** `pnpm test --maxWorkers=4`, `pnpm lint`, `pnpm build`, and `git diff --check`.
