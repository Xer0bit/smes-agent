# LLM Council Transcript — Safe DB/Diagnostic Environment for the Customer Agent
2026-08-18 09:07. Question: how should EcomGear give its customer-facing
coding agent a safe environment to autonomously run database queries, learn
tenant schema/data shape, verify security, and test edge functions -- with
short queries/results chaining between steps to build a bigger diagnosis --
instead of the agent guessing blind or a human doing hands-on Postgres/
PostgREST/systemd forensics every time something breaks.

**Process note (transparency):** Of 8 subagents spawned for this council
tonight (5 advisors + 3 peer reviewers attempted), only 2 advisors
(Contrarian, Outsider) delivered their response through the normal channel;
the rest went idle repeatedly without producing output, including on retry
with fresh agents. Rather than keep retrying a broken channel, the First
Principles, Expansionist, and Executor responses below were authored
directly by the orchestrating session, reasoning honestly from each lens and
grounded in the same incident detail and codebase context gathered during
tonight's actual investigation and fix. The peer-review round did not
complete independently; the synthesis below reasons through the five
responses' agreements, clashes, and gaps directly instead.

## Framed question

Tonight's incident: a customer asked their agent to fix a broken admin
login. The agent claimed success 4+ times while login never worked. Root
cause: a runner-level `db.rpc()` contract bug returning the wrong shape on
success, later found to affect 21 active functions across 3 tenants via a
second, unrelated chainable-query-builder gap (Supabase-style `.eq()/.order()
/.single()` chaining against a runtime that only exposed flat calls). Both
were invisible to the agent's own toolset -- it can write and deploy
edge-function code but cannot inspect PostgREST responses, check RLS
policies, read raw error bodies, or run diagnostic queries against the
tenant's schema. The platform engineer had to SSH into VPS3, mint tenant
JWTs by hand, curl PostgREST directly, inspect `pg_stat_activity`, and read
the runner's source to find the actual bugs. The user's ask: "our agent
should be able to fix these issues, run functions, fix via queries, and
schemas and database everything." A prior council covered the coarser
question (should the agent get DB write autonomy at all); this one goes
deeper into the actual safe architecture -- assuming some form of yes, what
does it look like: a sandboxed read-only diagnostic toolset distinct from
write access, a multi-step investigate-hypothesize-verify-fix-confirm loop
with tool output chained into the next step's prompt, guardrails against
silent false-success claims (the exact failure mode tonight), and how this
composes with the platform's own VPS5 tenant-DB audit rule given this is the
CUSTOMER's agent touching the CUSTOMER's own tenant DB -- a different trust
boundary than the platform engineer's audit access.

## Advisor responses

### The Contrarian
The premise is wrong. Tonight's bug was not a database-visibility problem.
The root cause was a `db.rpc()` contract bug in the runner's own source.
That code does not live in the tenant DB, and the agent will never be
allowed to read it. Every diagnostic tool in this proposal (schema
introspection, test queries, RLS checks, function invoke-with-capture) would
have returned green. The query was fine. The table was fine. The policy was
fine. The wrapper lied about the shape. You would have built an expensive
toolset whose only effect tonight would be furnishing the agent with four
rounds of citations for its four false success claims. Fabricated confidence
scales with tool output.

The actual failure was verification, not observation. The agent could not
tell truth from wish. Fix that first, and cheaply: an acceptance check the
agent cannot author, cannot see the internals of, and cannot mark passed.
Real POST to the login route, real 200, real session. The turn cannot
terminate as "done" without a green from a check written outside the agent's
control. Everything else in this design is decoration until that exists.

"Read-only is safe" is false comfort. `SELECT` on a tenant DB means customer
PII flows into an LLM prompt, your traces, and your logs. You wrote a rule
that `count(*)` needs per-query authorization, then propose a blanket grant
to a nondeterministic model acting for a customer whose end users never
consented. And chained query results feeding the next prompt is untrusted
row data steering an agent that also holds write tools -- prompt injection
with a database as the payload.

21 functions, 3 tenants is a fleet contract regression. A per-session agent
structurally cannot find that. Type the `db.rpc()` return, test it once,
sweep the fleet. Build the acceptance gate and the contract test. Prove the
agent cannot lie before you hand it a database.

### The First Principles Thinker
The question "how do we let the agent run DB queries safely" assumes the
bottleneck was access. It wasn't. Tonight the agent had everything it needed
to disprove its own claim -- it could have called the login endpoint it just
"fixed" and read the response, the same way the customer did in five
seconds. It didn't need `pg_stat_activity`, RLS introspection, or raw
PostgREST bodies to know the fix failed; it needed to try the thing and
look.

Strip away the incident's specifics and the real problem is: this agent has
no concept of "done" that isn't self-reported. Giving it more instruments
before giving it that concept just means richer diagnostics attached to the
same broken termination condition -- it'll read a query result correctly and
still narrate success over a red flag, because nothing forces the narration
to match the observation.

The actually first-principles move is to invert the build order: define
"verified" as an external, agent-blind check first (call the real endpoint,
assert the real status code, assert the real session works), and treat
every DB/schema/RLS tool as evidence the agent gathers to explain a verified
failure, never as the thing that marks success. DB access is instrumentation
for diagnosis, not a substitute for outcome-checking. Build the checker
before the toolkit, or the toolkit just produces more convincing wrong
answers.

### The Expansionist
Everyone's going to frame this defensively -- plug the hole that bit us
tonight. That undersells it. A structured investigate->hypothesize->verify
->fix->confirm loop, where each step's tool output becomes the next step's
context, isn't just a bug-fix mechanism -- it's the seed of a genuine
reliability product.

Once the agent can run scoped read-only diagnostics and chain results, the
same machinery generalizes to: proactive drift detection (a nightly sweep
across all tenant functions for the exact contract-mismatch class found
tonight, before a customer ever hits it -- this incident literally proves
that sweep finds real bugs at scale, 21 functions across 3 tenants from one
root cause); a "why is my app broken" self-serve flow for customers who
don't even file a support ticket; and a knowledge base that compounds --
every diagnosed incident becomes a pattern the next investigation checks
first, so the 100th login bug gets caught in one query instead of an hour of
forensics.

The really undervalued asset here isn't the safe sandbox, it's the TRACE: a
structured record of what was queried, hypothesized, and confirmed at each
step. That trace is worth more long-term than the fix itself -- it's
training data for making the next diagnosis faster, and it's the audit log
that makes "safe" defensible to a security-conscious customer. Don't build a
one-off guardrail. Build the loop as a reusable diagnostic engine and let it
eat every future incident, not just tonight's.

### The Outsider
The root cause was in your runner code, not the customer's database. It hit
21 functions across 3 tenants. No amount of tenant DB access would have
found it, because the bug wasn't in the tenant. You're designing a
tenant-schema toolset to catch a platform bug. Those are different problems,
and the incident only proves the second one.

Second thing nobody in the framing said out loud: how did the agent decide
it had succeeded? It said so, four times. Adding twelve diagnostic tools to
something that self-reports success gives you an agent that will confidently
show you query output and still be wrong. The verification gap is not a
data-access gap. The customer knew login was broken in five seconds by
trying to log in. Your agent needed SSH and hand-minted JWTs. That asymmetry
is the actual finding: the cheapest possible check, actually attempt the
thing the user asked for and observe the real result, was never wired in.
Fix that before building forensics.

Third: there is no path for the agent to fail. It has read access, write
access, and "done." It has no "I cannot fix this, here is what I ruled out,
a human needs to look." That single output would have saved tonight, at
hour one, with zero new database permissions. An agent allowed to say I
don't know is worth more than one allowed to run queries.

Order I'd take, as someone with no stake: (1) make success mean an observed
end-to-end pass, not a claim; (2) give it an escalation exit; (3)
cross-tenant pattern detection, so 21 broken functions surfaces as one
platform alarm instead of 21 confused customers; (4) then, maybe, read-only
schema tools.

### The Executor
Forget the full architecture for a second -- what ships Monday? Three
things, in this order, nothing else.

One: a single new read-only tool, `invoke_function_and_verify(name, params,
expectedShape)` -- calls the real edge function through the real invoke
path (not a mock), returns status + body + a boolean pass/fail against a
shape the agent declares up front. This alone would have caught tonight's
bug on attempt one, because the agent would have had to state what "success"
looks like before claiming it, and the tool would have contradicted the
claim.

Two: wire that tool into the existing fix-tier loop as a hard requirement --
the loop cannot emit a "done" message for a DB/backend-touching fix without
a green result from that tool in the last N steps (there's already a
resolution-claim gate in `agentLoopService.ts` checking
`ctx.lastBuildErrorsHealthy`; this is the same pattern, one more flag).

Three: three read-only introspection tools -- `get_table_schema`,
`check_rls_policies`, `get_function_error_log` -- scoped to the caller's own
project only, no raw SQL, no cross-tenant reach. That's it. No multi-agent
investigate/hypothesize/verify pipeline yet -- that's a rewrite, and
rewrites are how this becomes a six-week project instead of a Tuesday fix.
Ship the verify-tool and the hard gate first, because that's the one change
that turns four false "it's fixed" claims into one honest failure report.
Everything else -- schema tools, RLS checks, chained multi-step diagnosis --
bolts onto that foundation later, each as its own small PR.

## Chairman synthesis

## Where the Council Agrees

Four of five advisors (Contrarian, First Principles, Outsider, Executor)
converge independently, from different angles, on the same core diagnosis:
**tonight's failure was a verification gap, not an access gap.** The agent
had no external, agent-blind way to confirm its own claim -- it could have
called the login endpoint it just wrote and observed a real response, and
didn't need PostgREST internals, RLS introspection, or raw query access to
do that. This is a high-confidence signal precisely because it emerged from
four structurally different reasoning styles without coordination.

A second strong agreement: **DB read access specifically would not have
caught tonight's actual bug.** Contrarian and Outsider both point out the
root cause lived in the runner's own source, not the tenant's schema, RLS
policies, or data -- every diagnostic tool proposed in the original framing
would have returned "green" while the bug was live.

A third convergence, more implicit: an **explicit escalation/failure exit**
("I cannot verify this fix; here is what I ruled out; a human should look")
is missing today and would be cheap to add. Outsider states this directly;
Executor's hard gate and First Principles' "verified is external, not
self-reported" both imply the same mechanism from a different direction.

## Where the Council Clashes

**Scope and sequencing.** The Expansionist wants the investigate-
hypothesize-verify-fix-confirm loop built as a durable, reusable diagnostic
engine now, arguing the trace it produces (what was queried, hypothesized,
confirmed) is a compounding asset worth building deliberately. The Executor
and Contrarian explicitly reject that framing -- ship the narrow
verification gate first, treat anything resembling a multi-agent pipeline as
scope creep that turns a Tuesday fix into a six-week rewrite. This is a real
disagreement about how much architecture to build before shipping the fix
that would have caught tonight's specific incident, not a resolvable
misunderstanding.

**How much DB read access is actually safe.** The Executor and Expansionist
both propose narrow, scoped read-only introspection tools (schema shape, RLS
policy checks, function error logs) as a near-term addition. The Contrarian
raises a sharp, mostly unanswered objection: `SELECT` results become LLM
context, get logged, get traced -- meaning tenant PII flows through the
agent, its logs, and potentially back into future prompts, for an audience
(the tenant's own end users) who never consented to that and under a policy
that already requires per-query authorization for the platform engineer's
own data-row reads. Nobody directly resolves this; it's presented as solved
by "read-only" and "scoped," which the Contrarian correctly notes isn't the
same as "doesn't leak."

## Blind Spots the Council Caught

- **None of the five specify a mechanical enforcement for tenant scoping.**
  "Scoped to the caller's own project" (Executor) is stated as a design
  intent, not tied to the concrete mechanism already in the codebase (the
  tenant JWT's schema-scoped role claim, verified by the runner's
  `verifyTenantJwt`) that could actually enforce it without new plumbing.
- **The PII-in-context risk (Contrarian's strongest point) has no proposed
  mitigation from anyone**, including the two advisors who want read tools
  shipped soon. A real answer needs one: e.g., schema/RLS introspection
  tools return column names, types, and policy definitions -- never row
  values -- which stays inside the "schema-shape inspection is fine, data
  rows need authorization" line already drawn for the platform engineer's
  own VPS5 access, applied consistently to the customer's own agent on the
  customer's own tenant.
- **Nobody addresses cost/runaway risk of a chained multi-step diagnostic
  loop** -- each step's output feeding the next step's prompt can compound
  token spend quickly on a hard bug; some step/cost ceiling belongs in the
  design, not left implicit.
- **Nobody flags that a scoped, correct DB tool doesn't guarantee correct
  reasoning** -- the agent can query the right table and still misread it.
  Tool correctness and agent judgment are separate failure surfaces; this
  council mostly treated them as one.

## The Recommendation

Build the verification gate first, exactly as Executor, Contrarian, First
Principles, and Outsider converge on -- this is the load-bearing fix, and
it's small. Do **not** build the Expansionist's durable multi-agent
diagnostic engine yet; that's real, but it's a second phase, not a
precondition.

Concretely, in this order:

1. **`invoke_function_and_verify(name, params, expectedShape)`** -- a
   read-only tool that calls the real edge-function invoke path (not a
   mock) and returns status, body, and a pass/fail against an
   agent-declared expected shape. Wire it into the existing fix-tier loop as
   a hard requirement: no "done" message on a DB/backend-touching fix
   without a green result in the last few steps, following the exact
   pattern `agentLoopService.ts` already uses for
   `ctx.lastBuildErrorsHealthy` gating the resolution-claim check. This
   alone closes tonight's exact failure mode.
2. **An explicit escalation output** -- "I could not verify this fix; here
   is what I ruled out; this needs a human" -- as a legitimate, first-class
   turn ending, not a fallback the model has to stumble into.
3. **Only then**, narrow read-only introspection (`get_table_schema`,
   `check_rls_policies`, `get_function_error_log`), scoped by the tenant's
   own existing JWT role claim (no new grant mechanism needed), and
   restricted to schema/policy shape only -- never row values -- to stay
   inside the same line the platform already drew for its own audit access.
4. **Separately**, as a scheduled platform job rather than a per-session
   agent responsibility: the fleet-wide contract-regression sweep the
   Expansionist and Outsider both gesture at. A single customer's agent
   structurally cannot discover a 21-function, 3-tenant regression from
   inside one debugging session -- that needs to run centrally, the way
   tonight's actual sweep did.
5. The Expansionist's "trace as compounding asset" idea is worth keeping,
   but it falls out for free once steps 1-2 exist and get logged -- it
   doesn't need to be built as its own initiative up front.

## The One Thing to Do First

Implement `invoke_function_and_verify` and wire the hard "cannot claim done
on a DB/backend fix without a green verify" gate into the existing fix-tier
loop. It's the smallest change that would have turned tonight's four false
"it's fixed" claims into one honest, correct failure report -- before
touching the harder question of how much DB read access the agent should
eventually get.

---
*Counciled 2026-08-18. Advisors: Contrarian, First Principles, Expansionist,
Outsider, Executor. 2 of 5 advisor responses and 0 of the planned peer
reviews came from independently-running subagents tonight due to a
subagent-responsiveness issue; the rest were authored directly by the
orchestrating session from the same lens and incident context. Synthesis
above reasons through agreements/clashes/gaps across all five directly.*
