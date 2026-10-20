import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const user = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'breed_concepts',
    {
      title: 'Hybridize two concepts',
      description: 'Combine the mechanism of one concept with the structure of another into a concrete, testable design.',
      argsSchema: {
        concept_a: z.string().describe('The system you are building (structure), e.g. "distributed cache".'),
        concept_b: z.string().describe('The concept to borrow a mechanism from, e.g. "synaptic pruning".'),
        goal: z.string().optional().describe('What the hybrid should improve, e.g. "lower memory under bursty load".'),
      },
    },
    ({ concept_a, concept_b, goal }) =>
      user(
        `Design a hybrid of **${concept_a}** (the host system) and **${concept_b}** (the donor mechanism)${goal ? ` aimed at: ${goal}` : ''}.\n\n` +
          'Work through these steps and be explicit about uncertainty:\n' +
          `1. **Donor mechanism**: state the core rule of ${concept_b} in one or two sentences, independent of its domain.\n` +
          `2. **Mapping table**: map each element of the mechanism to a concrete component, signal, or parameter in ${concept_a}. Mark mappings that are weak.\n` +
          '3. **Design**: describe the hybrid architecture (components, data flow). Include equations only if they come from a real model you can name.\n' +
          '4. **Failure modes**: where the analogy breaks and what could go wrong in production.\n' +
          '5. **Smallest experiment**: a benchmark or prototype that would show whether the hybrid beats the baseline, with the metric to measure.\n' +
          '6. **Prior art**: call `search_papers` and `search_repositories` to check whether this already exists, and cite what you find.\n\n' +
          'Finish with a Markdown blueprint that can be passed to `scaffold_project`.',
      ),
  );

  server.registerPrompt(
    'code_to_theory',
    {
      title: 'Find the theory behind some code',
      description: 'Identify the formal model a piece of code implements and find the literature on it.',
      argsSchema: { code: z.string().describe('The code snippet to analyse.') },
    },
    ({ code }) =>
      user(
        'Analyse the following code and identify the formal model or algorithm it implements (for example a queueing model, control loop, consensus protocol, or caching policy).\n\n' +
          '1. Name the model and state its assumptions; say which assumptions the code violates.\n' +
          '2. Write the key equations in LaTeX, defining every symbol.\n' +
          '3. State known bounds or guarantees (complexity, competitive ratio, stability) and whether this implementation achieves them.\n' +
          '4. Call `search_papers` with the model name and cite 2-3 relevant papers from the results; do not cite papers you did not retrieve.\n\n' +
          '```\n' +
          code +
          '\n```',
      ),
  );

  server.registerPrompt(
    'cross_domain_brainstorm',
    {
      title: 'Cross-domain brainstorm',
      description: 'Workflow: abstract a software problem, find analogous research in other sciences, and turn the best analogy into a plan.',
      argsSchema: { problem: z.string().describe('The engineering problem, e.g. "rate limiting bursty API traffic".') },
    },
    ({ problem }) =>
      user(
        `Problem: ${problem}\n\n` +
          '1. Restate the problem as 2-3 domain-neutral mechanisms (no software jargon). Example: "LRU cache eviction" becomes "dropping rarely used signals to conserve a limited resource".\n' +
          '2. For each mechanism, call `find_cross_domain_research` (try fields biology, physics, complex_systems, economics).\n' +
          '3. From the returned papers, pick the 3 most promising analogies. For each, quote the specific finding from the abstract that you would borrow.\n' +
          '4. Rank them by feasibility and expected benefit, and say why.\n' +
          '5. For the top one, use the `breed_concepts` approach to produce a design, then call `evaluate_idea` to check for existing implementations.',
      ),
  );
}
