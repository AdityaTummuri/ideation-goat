# v1 (NitroStack) → v2 (official MCP SDK)

## Why

v1 ran only through `nitrostack-cli`. v2 uses `@modelcontextprotocol/sdk` directly, so it runs as a plain `node dist/index.js` (or `npx`) in any MCP client. It also adds Streamable HTTP for remote use.

## Tool mapping

| v1 tool | v2 | Notes |
|---|---|---|
| `search_academic_papers` | `search_papers` | Parallel; per-source errors instead of a fake "Scholars not available" paper |
| `search_knowledge_grid` (target) | `search_papers` + `search_repositories` | Mock repos (`github.com/example/...`) removed |
| `search_knowledge_grid` (discovery) | `find_cross_domain_research` | Real non-CS arXiv category search instead of a hardcoded analogy list |
| `breed_concepts` | prompt `breed_concepts` | Was string templates + canned LaTeX; now a prompt for the host LLM |
| `bridge_code_and_theory` | prompt `code_to_theory` | Was keyword → canned formula |
| `assess_viability` | `search_patents` | No longer invents patents when none are found |
| `search_gitlab_repos` | `search_repositories` | Was hardcoded; now the real GitLab API |
| `audit_hacker_news_trends` | `hacker_news_trends` | Was a hardcoded 0.72 sentiment / 142 mentions; now real Algolia counts (no sentiment) |
| `get_repo_health` + `check_repo_health` | `repo_health` | Merged; score breakdown exposed; repo-name-as-package OSV lookup removed |
| `analyze_repo_bugs` | `repo_bug_patterns` | Described accurately as keyword clustering (it was never TF-IDF) |
| `check_ecosystem_lockin` | `repo_cloud_lockin` | Also reads go.mod |
| `analyze_workspace_ast` | `workspace_profile` | Path-sandboxed; adds license + layout detection |
| `verify_workspace_fit` + `align_system_architecture` | `repo_workspace_fit` | Fixes GPL text being detected as MIT |
| `scan_local_cves` | `scan_dependency_vulnerabilities` | Queries exact versions from lockfiles (v1 queried by name only, so every historical CVE was reported); CVSS v3 scoring; fixed versions |
| `profile_dependency_injection` | `dependency_injection_report` | Ignores built-ins (`new Map()`, `new Date()`), skips tests, labelled heuristic |
| `profile_repo_hardware_footprint` | `estimate_edge_footprint` | Ranges + `confidence: low` |
| `forecast_live_costs` | `estimate_hosting_cost` | Assumptions are inputs and are echoed back |
| `write_scaffolding_files` + `generate_docker_scaffolding` | `scaffold_project` | Runnable starters; refuses to overwrite; sandboxed |
| `orchestrate_architectural_workflow` | `evaluate_idea` | Progress notifications; no `example/<name>` repo lookups |
| `auto_heal_parameters` | removed | Input validation is the SDK's job (Zod schemas) |
| `verify_identity_token` | removed | Verified tokens against a secret hardcoded in source |
| `ideation-goat://canvas` | `ideation-goat://session/last-search` | Per-session instead of global |

## Removed dependencies and config

`@nitrostack/core`, `@nitrostack/cli`, `@modelcontextprotocol/ext-apps`, `dotenv`, the server-side Gemini/OpenAI calls (the host model does the synthesis), and the unused Pinecone/Supabase/Chroma code paths.

## Security fixes

- `console.log` in tool handlers wrote to stdout and corrupted the stdio protocol stream. All logging now goes to stderr.
- The path check used `startsWith`, so `/root-evil` passed for root `/root`. Three tools had no path check at all.
- v2's HTTP transport binds to localhost by default and requires `MCP_AUTH_TOKEN` otherwise.
- A JWT HMAC secret was committed in `identity_sandbox.ts`. **If that secret was used anywhere real, rotate it.**
