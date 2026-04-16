# aSafeLobotomy's Copilot Extension

Companion VS Code extension for [copilot-instructions-template](https://github.com/asafelobotomy/copilot-instructions-template).

Provides Language Model Tools for GitHub Copilot agents: profile management, extension sync, and MCP server lifecycle.

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

## Language Model Tools

### Profile Management

| Tool | Description |
|------|-------------|
| `get_active_profile` | Detect the active VS Code profile |
| `list_profiles` | List known profiles |
| `get_workspace_profile_association` | Check workspace profile binding |
| `ensure_repo_profile` | Create/switch to a repo-specific profile |

### Extension Management

| Tool | Description |
|------|-------------|
| `get_installed_extensions` | Profile-aware extension enumeration |
| `sync_extensions_with_recommendations` | Diff installed vs `.vscode/extensions.json` |

### MCP Lifecycle

| Tool | Description |
|------|-------------|
| `get_mcp_status` | Check configured MCP servers and provider status |
| `restart_mcp_server` | Trigger MCP server re-resolution (restart) |

## Development

```bash
npm install
npm run compile
# Press F5 in VS Code to launch Extension Development Host
```

## License

MIT
