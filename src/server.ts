import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionState } from './lib/context.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerBuildTools } from './tools/build.js';
import { registerPipelineTools } from './tools/pipeline.js';
import { registerRepoTools } from './tools/repos.js';
import { registerResearchTools } from './tools/research.js';
import { registerWorkspaceTools } from './tools/workspace.js';

export const VERSION = '2.0.0';

const INSTRUCTIONS = `Ideation GOAT helps research and de-risk software ideas.
- Research: search_papers, find_cross_domain_research, search_patents, hacker_news_trends
- Open source due diligence: search_repositories, repo_health, repo_bug_patterns, repo_cloud_lockin, estimate_edge_footprint
- Local project (inside WORKSPACE_ROOT): workspace_profile, repo_workspace_fit, scan_dependency_vulnerabilities, dependency_injection_report, scaffold_project
- Planning: evaluate_idea (one-call overview), estimate_hosting_cost
Prompts: breed_concepts, code_to_theory, cross_domain_brainstorm.
Results marked heuristic or low confidence are estimates; say so when you relay them.`;

/** Build a fully configured server. One instance per client session. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'ideation-goat', title: 'Ideation GOAT', version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  const state: SessionState = { lastSearch: null };

  registerResearchTools(server, state);
  registerRepoTools(server, state);
  registerWorkspaceTools(server);
  registerBuildTools(server);
  registerPipelineTools(server, state);
  registerPrompts(server);
  registerResources(server, state, VERSION);
  return server;
}
