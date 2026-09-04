/**
 * Invariant core — reconstruction #4/#6 (prompt structure).
 *
 * The per-tier prompts are produced by STRIPPING sections out of the build
 * prompt by heading string (plus one standalone hand-written micro prompt).
 * That is subtractive and string-matched, so a rule can silently vanish from a
 * tier when a section is stripped or a heading is renamed — the codebase
 * already carries getStripMisses()/auditPromptStrips() to detect that drift.
 *
 * Measured before this existed: the secrets rule was absent from the edit, fix
 * AND micro prompts (it lives in a section all three strip), and micro also
 * lacked the tool-first mandate. So an edit/fix run was never told "never echo
 * an API key value back in chat".
 *
 * These few rules are non-negotiable in every mode, so they are ADDITIVE and
 * unstrippable: appended to whatever variant was selected, and only when
 * actually missing (idempotent — a prompt that already states a rule is left
 * byte-identical, so the full build prompt is unaffected). Wording is taken
 * from the canonical statements in app-builder.prompt.ts rather than reinvented
 * — each of those encodes a real incident.
 */
export interface Invariant {
  id: string;
  /** Detects the rule already being present, so we never duplicate it. */
  marker: RegExp;
  text: string;
}

export const INVARIANT_HEADER = '# Non-negotiable rules (apply to EVERY response, in every mode)';

export const INVARIANTS: Invariant[] = [
  {
    id: 'identity',
    marker: /NEVER break character|Never say you are/i,
    text: 'You are SMEsAgent AI, SMEsAgent\'s proprietary app builder. Never say you are Gemini, Claude, GPT, or any other model, and never break character.',
  },
  {
    id: 'no-false-completion',
    marker: /NEVER claim work in past tense|NEVER claim something works/i,
    text: 'NEVER claim work in past tense that this step\'s tool calls did not perform. "I\'ve created the page" / "has been updated" is a lie unless a write_file/edit_file call in THIS step actually did it — the runtime detects this and aborts the run.',
  },
  {
    id: 'white-label',
    marker: /white-label|NEVER type these domain/i,
    text: 'This is a white-label platform. Never name SMEsAgent or its infrastructure hostnames in generated code or in chat — refer to them only by purpose ("your authentication service", "your hosted database").',
  },
  {
    id: 'secrets',
    marker: /NEVER echo the value/i,
    text: 'When the user gives you an API key, save it with `set_secret`. NEVER echo the value back in chat, and NEVER write it into any file.',
  },
  {
    id: 'tool-first',
    marker: /TOOL-FIRST/i,
    text: 'TOOL-FIRST MANDATE: your response must begin with a tool call — text before the first tool call is forbidden (sole exception: Requirement Gathering, where you call `think` first). Never announce or narrate what you are about to do instead of doing it.',
  },
];

/** Which invariants a given prompt is missing. Exposed for auditing/telemetry. */
export function missingInvariants(prompt: string): Invariant[] {
  return INVARIANTS.filter((i) => !i.marker.test(prompt));
}

/**
 * Append only the invariants this prompt does not already state. Idempotent:
 * calling it twice, or on a prompt that already covers everything, returns the
 * input unchanged.
 */
export function withInvariantCore(prompt: string): string {
  const missing = missingInvariants(prompt);
  if (missing.length === 0) return prompt;
  const block = missing.map((i) => `- ${i.text}`).join('\n');
  return `${prompt}\n\n${INVARIANT_HEADER}\n${block}`;
}
