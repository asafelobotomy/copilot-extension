# Changelog

## 0.2.0 (unreleased)

- Add the Activity Bar Control Center and MCP Servers views for workspace health, MCP inspection, and lifecycle actions
- Align the Control Center with `copilot-instructions-template` by detecting repo mode, parsing `.github/copilot-version.md`, and launching canonical setup, update, restore, and factory-restore chat flows
- Add extension install/uninstall tools and a workspace index tool so Copilot agents can manage extensions and inspect `workspace-index.json`
- Fix Control Center loading so the webview resolves immediately and falls back gracefully if a snapshot section stalls

- Fix `asafelobotomy_session_reflect` so it writes the heartbeat completion markers expected by the stop-hook runtime (`state.json`, `.heartbeat-session`, `.heartbeat-events.jsonl`)

- Initial scaffold
- Phase 1: Profile management tools (`get_active_profile`, `list_profiles`, `get_workspace_profile_association`, `ensure_repo_profile`)
- Phase 1: Extension management tools (`get_installed_extensions`, `sync_extensions_with_recommendations`)
- Phase 2: MCP lifecycle tools (`get_mcp_status`, `restart_mcp_server`)
- Phase 2: MCP server definition provider with file watcher for auto-restart on `mcp.json` changes
