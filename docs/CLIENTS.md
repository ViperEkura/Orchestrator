# Desktop and web clients

The Windows client is a native WinForms window hosting the shared React UI through Microsoft WebView2. It starts a bundled Node runtime on authenticated loopback HTTP. The same interface is available in a browser. UI text defaults to English.

## Run the Windows app

Extract the complete Windows package and double-click **Orchestrator.exe**. Keep the DLLs and `resources` folder beside it. Node.js and npm are included/not required on the target computer. If WebView2 Runtime is missing, run the included MicrosoftEdgeWebview2Setup.exe once.

Settings, agent definitions and conversation history use `%USERPROFILE%\.orchestrator`. The default new workspace is `Documents\Orchestrator`; use **+** beside Projects to select an existing directory. Alternatively:

```powershell
.\Orchestrator.exe --cwd C:\Develop\MyProject
```

Close an existing Orchestrator runtime using the same data directory before opening the app. Closing the window stops its owned backend. This development build is unsigned and distributed as a portable folder/ZIP, not a single-file installer.

## Build from source

```powershell
npm install
npm run package:desktop
# dist\windows\Orchestrator\Orchestrator.exe
```

The Windows build uses PowerShell 7 and the system .NET Framework C# compiler. It downloads the pinned WebView2 SDK and Microsoft runtime bootstrapper and checks their Microsoft Authenticode signatures. `npm run desktop` builds and opens the exe.

For a browser client, run `npm run web` and open the printed URL (default `http://127.0.0.1:4317`). If `ORCHESTRATOR_TOKEN` is configured, enter it on the connection screen. The UI keeps the runtime token in sessionStorage for refresh; provider API keys stay on the server. Desktop-owned tokens are generated per launch, passed through the initial URL fragment and then removed from the address.

## Included

- Project selection, searchable conversations, per-conversation drafts, multiline/IME input.
- Streaming responses, Markdown/code/tables, collapsible thinking and tools. Failed tools use red; other tool rows stay gray.
- Automatic approvals and user questions, dismiss/reopen, custom answers, three approval modes, stop and retry.
- Explicit parallel read-only agent selection, child-task navigation and saved output previews with paged loading.
- User-turn navigation, scroll/follow controls, responsive sidebar and optional details panel.

New projects use the runtime's loaded provider settings and their own AGENTS.md. Folder selection does not reload project-specific provider settings; start with `--cwd` to do that. Existing sessions keep their directory. Math rendering was removed. MCP, attachments, signed installers and automatic updates are not included.

## Code and verification

- `src/clients/web/`: React UI, sanitized Markdown, styling and SDK/SSE integration.
- `src/clients/desktop/Orchestrator.cs`: native window, WebView2 and backend lifecycle.
- `src/clients/desktop/server.ts`: packaged runtime entry.
- `scripts/package-desktop.ps1`, `scripts/bundle-desktop.mjs`: Windows build and resources.
- `src/transport/web.ts`: allowlisted static assets, no project/configuration file serving.

`npm run test:web` builds the package and runs browser plus exe integration tests with temporary project/data folders and deterministic providers. Browser tests use installed Windows Edge; set `ORCHESTRATOR_BROWSER` to another Chromium executable if necessary. Native tests enable a temporary WebView2 debug port only in their environment. The production launcher does not enable a debug port or expose Node to the UI.

See [Microsoft WebView2 deployment](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution) for runtime requirements.

## Interface design

See [Interface design](INTERFACE_DESIGN.md) for layout dimensions, colors, responsive behavior, keyboard navigation, focus and shared request flows. Browser and native GUI tests live in `tests/web/`; `npm run test:web` builds the desktop package and runs them.
