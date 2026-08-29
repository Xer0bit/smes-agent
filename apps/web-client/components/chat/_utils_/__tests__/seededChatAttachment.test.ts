/**
 * The handoff crosses a navigation, so the two fields ChatAttachment has and
 * AgentAttachment does not have to be rebuilt rather than carried.
 *
 * The one that actually bites: previewUrl. The object URL the original file
 * picker created belongs to the page that made it, and a sessionStorage
 * round-trip would serialise it to a string pointing at nothing. Falling back
 * to publicUrl is what makes the chip render an image instead of a broken one.
 */
import { describe, it, expect } from 'vitest';
import { seededChatAttachment } from '../agentChatHelpers';
import type { AgentAttachment } from '@/eCG/UserPrompt/types';

const att = (over: Partial<AgentAttachment> = {}): AgentAttachment => ({
  name: 'brief.pdf',
  type: 'application/pdf',
  category: 'document',
  tempPath: '/tmp/upload-abc',
  publicUrl: 'https://storage.example/brief.pdf',
  ...over,
});

describe('rebuilding a composer attachment', () => {
  it('carries the fields the agent actually needs', () => {
    const out = seededChatAttachment(att());
    expect(out.tempPath).toBe('/tmp/upload-abc');
    expect(out.name).toBe('brief.pdf');
    expect(out.type).toBe('application/pdf');
    expect(out.category).toBe('document');
  });

  it('uses publicUrl as the preview, never a stale object URL', () => {
    const out = seededChatAttachment(att({ publicUrl: 'https://storage.example/pic.png', category: 'image' }));
    expect(out.previewUrl).toBe('https://storage.example/pic.png');
    expect(out.previewUrl.startsWith('blob:')).toBe(false);
  });

  it('degrades to empty rather than undefined when publicUrl is missing', () => {
    // publicUrl is optional on AgentAttachment; an <img src={undefined}> warns
    // and an <img src=""> simply does not load. Prefer the quiet one.
    const out = seededChatAttachment(att({ publicUrl: undefined }));
    expect(out.previewUrl).toBe('');
    expect(out.publicUrl).toBe('');
  });

  it('derives a stable id from tempPath so a double-seed cannot collide keys', () => {
    const a = seededChatAttachment(att());
    const b = seededChatAttachment(att());
    expect(a.id).toBe(b.id);
    expect(seededChatAttachment(att({ tempPath: '/tmp/other' })).id).not.toBe(a.id);
  });

  it('reports size 0 rather than inventing one', () => {
    // size is not carried across the handoff and only feeds the size label.
    expect(seededChatAttachment(att()).size).toBe(0);
  });
});
