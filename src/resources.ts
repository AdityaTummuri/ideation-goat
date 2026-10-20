import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from './config.js';
import type { SessionState } from './lib/context.js';

export const LAST_SEARCH_URI = 'ideation-goat://session/last-search';

export function registerResources(server: McpServer, state: SessionState, version: string): void {
  server.registerResource(
    'last-search',
    LAST_SEARCH_URI,
    {
      title: 'Last search results',
      description: 'Results of the most recent search in this session (papers, repositories, patents, cross-domain research, or idea evaluation).',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(state.lastSearch ?? { status: 'empty', hint: 'Run a search tool first.' }, null, 2) }],
    }),
  );

  server.registerResource(
    'server-status',
    'ideation-goat://status',
    {
      title: 'Server configuration status',
      description: 'Which optional integrations are configured (never shows key values) and the workspace root used for local file access.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              version,
              workspaceRoot: config.workspaceRoot,
              integrations: {
                github: config.githubToken ? 'token (5,000 req/h)' : 'anonymous (60 req/h, search 10 req/min)',
                gitlab: config.gitlabToken ? 'token' : 'anonymous',
                semanticScholar: config.semanticScholarKey ? 'api key' : 'anonymous (shared rate limit)',
                unpaywall: config.unpaywallEmail ? 'enabled' : 'disabled (set UNPAYWALL_EMAIL)',
                patents: config.serpApiKey ? 'enabled (SerpApi)' : 'disabled (set SERPAPI_API_KEY)',
                arxiv: 'anonymous',
                hackerNews: 'anonymous',
                osv: 'anonymous',
              },
            },
            null,
            2,
          ),
        },
      ],
    }),
  );
}
