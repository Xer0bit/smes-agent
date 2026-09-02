/**
 * declare_architecture: the plan a feature or build must state before it
 * writes a page.
 *
 * The agent's structural failures all had the same shape: it started writing
 * the first file it thought of, so an "admin page" became a button on the
 * user page, data stayed in localStorage, and there was one route for
 * everything. Naming the routes, the tables, the auth boundary and the edge
 * functions first is what a person does before opening an editor; this tool
 * makes that the first write of a feature/build run (agentToolSet.ts warns
 * once, then refuses structural writes until it is called).
 *
 * The declaration is also saved to project knowledge, so the next run on the
 * project starts from the same architecture instead of inventing another.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { recordKnowledge } from '../services/knowledge.service.js';

const schema = z.object({
  routes: z.array(z.string()).min(1).max(40).describe(
    'Every route with its purpose, e.g. "/ - storefront", "/admin - back office (admin role only)", ' +
    '"/admin/products - manage products". An admin or account area is its own routes, never a toggle on a public page.'
  ),
  dataModel: z.array(z.string()).max(40).describe(
    'Hosted-database tables with their purpose, e.g. "products - catalog", "orders - one per checkout", ' +
    '"profiles - one per user, holds role". Empty only for an app with no persistent data.'
  ),
  auth: z.string().max(400).describe(
    'How sign-in and roles work: which edge functions (auth-signup, auth-login, auth-session), where the role ' +
    'lives, which routes are guarded. Write "none" only if the app has no accounts at all.'
  ),
  edgeFunctions: z.array(z.string()).max(40).describe(
    'Server-side functions and what each does (auth, payments, privileged writes). Empty if none are needed.'
  ),
  notes: z.string().max(600).optional().describe('Anything else that shapes the build: layouts, shared state, constraints from the owner.'),
});

export type DeclaredArchitecture = z.infer<typeof schema>;

function render(a: DeclaredArchitecture): string {
  const lines = [
    'Routes:', ...a.routes.map((r) => `- ${r}`),
    'Data model:', ...(a.dataModel.length ? a.dataModel.map((t) => `- ${t}`) : ['- none']),
    `Auth: ${a.auth}`,
    'Edge functions:', ...(a.edgeFunctions.length ? a.edgeFunctions.map((f) => `- ${f}`) : ['- none']),
  ];
  if (a.notes) lines.push(`Notes: ${a.notes}`);
  return lines.join('\n');
}

export const declareArchitectureTool: ToolDefinition<DeclaredArchitecture> = {
  name: 'declare_architecture',
  description:
    'State the architecture BEFORE writing any page or route on a feature or build task: the routes, the ' +
    'hosted-database tables, how sign-in and roles work, and the edge functions. A few lines each. This is ' +
    'refused-until-called for structural writes, and it is saved to project knowledge so later runs build on ' +
    'the same plan. Call it again to revise; the latest declaration replaces the previous one.',
  inputSchema: schema,

  execute: async (args, ctx: AgentContext) => {
    ctx.declaredArchitecture = args;
    ctx.architectureWarned = false;
    const text = render(args);
    if (ctx.projectId) {
      await recordKnowledge(ctx.projectId, [{ source: 'agent', source_ref: 'agent:architecture', heading: 'Architecture', content: text }]);
    }
    const adminRoute = args.routes.some((r) => /\/admin\b/i.test(r));
    const adminAuth = /role|admin/i.test(args.auth);
    const warn = adminRoute && !adminAuth
      ? '\n\nWARNING: you declared an /admin route but the auth line does not say how the admin role is checked. ' +
        'Admin access must come from the session\'s role in the hosted database, behind a route guard.'
      : '';
    return `Architecture recorded and saved to project knowledge.\n\n${text}\n\nBuild to this. Revise with another declare_architecture call if the plan changes.${warn}`;
  },
};
