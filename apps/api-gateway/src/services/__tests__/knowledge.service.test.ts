import { describe, it, expect } from 'vitest';
import {
  selectKnowledgeForPrompt, uploadsFromRun, parseDistilledFacts, renderKnowledge, estimateTokens, knowledgeSlug,
  type KnowledgeChunk,
} from '../knowledge.service.js';

function chunk(over: Partial<KnowledgeChunk> & Pick<KnowledgeChunk, 'id' | 'source' | 'heading' | 'content'>): KnowledgeChunk {
  return {
    project_id: 'p', source_ref: over.id, tokens: estimateTokens(over.content), archived: false,
    created_at: '2026-09-02T10:00:00Z', updated_at: '2026-09-02T10:00:00Z', ...over,
  };
}

describe('selectKnowledgeForPrompt', () => {
  it('never sends an archived chunk, whatever its relevance', () => {
    const c = chunk({ id: 'a', source: 'chat', heading: 'checkout flow', content: 'checkout cart stripe', archived: true });
    expect(selectKnowledgeForPrompt([c], 'fix the checkout')).toEqual([]);
  });

  it('always carries owner notes, ahead of run history', () => {
    const note = chunk({ id: 'n', source: 'note', heading: 'Brand', content: 'Use HKD, never USD', created_at: '2026-01-01T00:00:00Z' });
    const chat = chunk({ id: 'c', source: 'chat', heading: 'checkout flow', content: 'checkout cart', created_at: '2026-09-01T00:00:00Z' });
    const picked = selectKnowledgeForPrompt([chat, note], 'fix the checkout');
    expect(picked.map((c) => c.id)).toEqual(['n', 'c']);
  });

  it('drops run history that shares nothing with the prompt', () => {
    const chat = chunk({ id: 'c', source: 'chat', heading: 'logo colours', content: 'the logo is blue' });
    expect(selectKnowledgeForPrompt([chat], 'fix the checkout')).toEqual([]);
  });

  it('skips, rather than truncates, a chunk that would overflow the budget', () => {
    const big = chunk({ id: 'big', source: 'upload', heading: 'spec checkout', content: 'checkout '.repeat(2000) });
    const small = chunk({ id: 'small', source: 'change', heading: 'checkout fix', content: 'edited Checkout.tsx' });
    const picked = selectKnowledgeForPrompt([big, small], 'checkout', 500);
    expect(picked.map((c) => c.id)).toEqual(['small']);
  });
});

describe('agent-saved facts survive selection without a keyword hit', () => {
  it('keeps an agent fact for an unrelated prompt, drops unrelated history', () => {
    const fact = chunk({ id: 'f', source: 'agent', heading: 'Currency', content: 'All prices are HKD' });
    const hist = chunk({ id: 'h', source: 'chat', heading: 'logo', content: 'logo is blue' });
    expect(selectKnowledgeForPrompt([hist, fact], 'add a contact page').map((c) => c.id)).toEqual(['f']);
  });
});

describe('uploadsFromRun', () => {
  it('keeps uploaded text verbatim, keyed by run and file, and skips empty extractions', () => {
    const entries = uploadsFromRun({ agentRunId: 'run1', uploads: [{ name: 'spec.pdf', text: 'The cart must show totals.' }, { name: 'empty.txt', text: '  ' }] });
    expect(entries).toEqual([{ source: 'upload', source_ref: 'run1:spec.pdf', heading: 'spec.pdf', content: 'The cart must show totals.' }]);
  });
});

describe('parseDistilledFacts', () => {
  it('reads a JSON array, tolerating prose around it, and caps at three', () => {
    const raw = 'Sure. [{"heading":"Currency","content":"Prices are always in HKD."},{"heading":"x","content":"too short"},' +
      '{"heading":"Auth","content":"Login is an edge function, not a platform service."},' +
      '{"heading":"Header","content":"Owner wants the old header kept as is."},{"heading":"Extra","content":"A fourth durable fact here."}] done';
    const facts = parseDistilledFacts(raw);
    expect(facts.map((f) => f.heading)).toEqual(['Currency', 'Auth', 'Header']);
  });

  it('returns nothing for [] or garbage', () => {
    expect(parseDistilledFacts('[]')).toEqual([]);
    expect(parseDistilledFacts('no facts')).toEqual([]);
    expect(parseDistilledFacts('[{"heading": 5}]')).toEqual([]);
  });
});

describe('knowledgeSlug', () => {
  it('turns a heading into a stable key so re-saving replaces', () => {
    expect(knowledgeSlug('Payment provider (Stripe)!')).toBe('payment-provider-stripe');
    expect(knowledgeSlug('   ')).toBe('fact');
  });
});

describe('renderKnowledge', () => {
  it('labels each chunk with its source and is empty with no chunks', () => {
    expect(renderKnowledge([])).toBe('');
    const out = renderKnowledge([chunk({ id: 'n', source: 'note', heading: 'Brand', content: 'Use HKD' })]);
    expect(out).toContain('### Brand (Owner note)');
    expect(out).toContain('Use HKD');
  });
});
