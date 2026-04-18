# aSafeLobotomy's Copilot Extension

Companion VS Code extension for [copilot-instructions-template](https://github.com/asafelobotomy/copilot-instructions-template).

Provides Language Model Tools and a Control Center for GitHub Copilot agents: template lifecycle status, real VS Code profile discovery, extension sync, workspace state, and MCP server lifecycle.

## Install

Download the `.vsix` from [GitHub Releases](https://github.com/asafelobotomy/copilot-extension/releases/latest), then:

```bash
code --install-extension asafelobotomy-copilot-extension-*.vsix
```

Or install from within VS Code: Extensions view > `...` menu > "Install from VSIX..."

## Requirements

- VS Code 1.101.0+ (Insiders recommended for proposed API support)
- GitHub Copilot extension
- `--enable-proposed-api=asafelobotomy.copilot-extension` launch flag (for MCP features)

## Control Center

The Activity Bar Control Center now focuses on the template's core workflow first:

- Detects whether the workspace looks like the template source repo, a consumer repo, or an unmanaged workspace
- Parses `.github/copilot-version.md` to show installed template version, ownership mode, fingerprints, and setup-answer coverage
- Launches Copilot Chat with the template's canonical lifecycle triggers for setup, update, restore, and factory restore
- Shows the real VS Code profile associated with the current workspace, discovered profiles on disk, and a picker-driven Switch Profile action
- Continues to surface extension recommendations, workspace index health, heartbeat state, and MCP status

## Language Model Tools

### Profile Management

- `get_active_profile`: Detect the VS Code profile associated with the current workspace.
- `list_profiles`: List real VS Code user profiles discovered from local user data.
- `get_workspace_profile_association`: Check the workspace-to-profile association from VS Code user data.
- `get_profile_details`: Inspect a real profile's settings, extensions, snippets, chat models, and storage entries.
- `ensure_repo_profile`: Create or switch to a repo-specific profile.

Profile notes:
The extension reads workspace/profile associations and profile folders directly from VS Code's local user-data storage.

### Extension Management

| Tool                                   | Description                                 |
| -------------------------------------- | ------------------------------------------- |
| `get_installed_extensions`             | Profile-aware extension enumeration         |
| `sync_extensions_with_recommendations` | Diff installed vs `.vscode/extensions.json` |

### MCP Lifecycle

| Tool                 | Description                                       |
| -------------------- | ------------------------------------------------- |
| `get_mcp_status`     | Check configured MCP servers and provider status  |
| `restart_mcp_server` | Trigger MCP server re-resolution (restart)        |

## Feedback

To report a bug or suggest a feature, use the GitHub issue tracker:

- Bug reports: open an issue at [github.com/asafelobotomy/copilot-extension/issues](https://github.com/asafelobotomy/copilot-extension/issues) and include the extension version, VS Code version, OS, the workspace context, exact reproduction steps, and what you expected to happen.
- Feature suggestions: open an issue at [github.com/asafelobotomy/copilot-extension/issues](https://github.com/asafelobotomy/copilot-extension/issues) and describe the workflow you are trying to improve, the limitation you hit, and the behavior or tool you want the extension to add.
- Title guidance: prefix the issue title with `bug:` or `feature:` so it is easy to triage from the extension details page.

## Development

```bash
npm install
npx tsc -p tsconfig.json --noEmit
npm run compile
# Press F5 in VS Code to launch Extension Development Host
```

## License

MIT
