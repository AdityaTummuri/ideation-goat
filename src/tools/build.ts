import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { estimateCost } from '../analysis/cost.js';
import { renderScaffold, writeFiles } from '../analysis/scaffold.js';
import { resolveInWorkspace } from '../lib/paths.js';
import { ok, safe } from '../lib/result.js';

export function registerBuildTools(server: McpServer): void {
  server.registerTool(
    'estimate_hosting_cost',
    {
      title: 'Estimate monthly hosting cost (rough)',
      description:
        'Back-of-envelope monthly cost for AWS (API Gateway + Lambda + DynamoDB), Vercel, Supabase, or Neon from traffic assumptions. List prices are hardcoded in the server and may be out of date; every assumption and line item is returned so you can check them.',
      inputSchema: {
        provider: z.enum(['aws', 'vercel', 'supabase', 'neon']),
        monthly_requests: z.number().int().nonnegative(),
        avg_response_kb: z.number().positive().default(50),
        monthly_active_users: z.number().int().nonnegative().optional().describe('Supabase auth MAU.'),
        database_gb: z.number().nonnegative().optional(),
        lambda_memory_mb: z.number().int().min(128).max(10240).optional(),
        lambda_duration_ms: z.number().positive().optional(),
        compute_hours: z.number().nonnegative().optional().describe('Neon active compute hours per month.'),
      },
      outputSchema: {
        provider: z.string(),
        plan: z.string(),
        totalUsd: z.number(),
        lineItems: z.array(z.object({ item: z.string(), usd: z.number() })),
        assumptions: z.record(z.string(), z.union([z.number(), z.string()])),
        caveat: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async (a) =>
      ok({
        ...estimateCost({
          provider: a.provider,
          monthlyRequests: a.monthly_requests,
          avgResponseKb: a.avg_response_kb,
          monthlyActiveUsers: a.monthly_active_users,
          databaseGb: a.database_gb,
          lambdaMemoryMb: a.lambda_memory_mb,
          lambdaDurationMs: a.lambda_duration_ms,
          computeHours: a.compute_hours,
        }),
      }),
    ),
  );

  server.registerTool(
    'scaffold_project',
    {
      title: 'Scaffold a project skeleton',
      description:
        'Create a runnable starter project (Node, Python, Go, or Rust) with a health-check HTTP server, Dockerfile, docker-compose.yml, .env.example, and your design written to docs/BLUEPRINT.md. Writes only inside WORKSPACE_ROOT and refuses to overwrite existing files unless overwrite=true.',
      inputSchema: {
        directory: z.string().min(1).describe('Target directory relative to WORKSPACE_ROOT; created if missing.'),
        project_name: z.string().min(1).max(80),
        stack: z.enum(['node', 'python', 'go', 'rust']),
        blueprint_markdown: z.string().min(1).describe('Design document (Markdown) for the project, e.g. the output of the breed_concepts prompt.'),
        port: z.number().int().min(1).max(65535).default(8080),
        overwrite: z.boolean().default(false),
      },
      outputSchema: { directory: z.string(), filesCreated: z.array(z.string()), nextSteps: z.array(z.string()) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ directory, project_name, stack, blueprint_markdown, port, overwrite }) => {
      const dir = resolveInWorkspace(directory);
      const { created } = writeFiles(dir, renderScaffold({ projectName: project_name, stack, blueprintMarkdown: blueprint_markdown, port }), overwrite);
      return ok({ directory: dir, filesCreated: created, nextSteps: [`cd ${dir}`, 'cp .env.example .env', 'docker compose up --build', `curl http://localhost:${port}/`] });
    }),
  );
}
