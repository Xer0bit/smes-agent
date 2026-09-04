import { describe, expect, it } from 'vitest';
import { extractPreviewProjectIdFromReferer } from '../previewState.js';

// Regression: the referer regex used to require a bare 36-char hex/hyphen
// uuid, so guest project ids (`guest-<uuid>`, non-hex letters, 42 chars)
// never matched -- their /assets/,/images/,etc. requests fell through to a
// plain 404 instead of being rescued to /preview/{id}/assets/....

const UUID = 'a1b2c3d4-e5f6-4890-9bcd-ef1234567890';

describe('extractPreviewProjectIdFromReferer', () => {
    it('extracts a plain uuid project id', () => {
        expect(extractPreviewProjectIdFromReferer(`https://preview.SMEsAgent.app/preview/${UUID}/`))
            .toBe(UUID);
    });

    it('extracts a guest-prefixed project id', () => {
        const guestId = `guest-${UUID}`;
        expect(extractPreviewProjectIdFromReferer(`https://preview.SMEsAgent.app/preview/${guestId}/`))
            .toBe(guestId);
    });

    it('returns null when there is no preview path', () => {
        expect(extractPreviewProjectIdFromReferer('https://preview.SMEsAgent.app/p/some-slug')).toBeNull();
    });

    it('returns null for a malformed id', () => {
        expect(extractPreviewProjectIdFromReferer('https://preview.SMEsAgent.app/preview/not-an-id/')).toBeNull();
    });

    it('returns null when referer is missing', () => {
        expect(extractPreviewProjectIdFromReferer('')).toBeNull();
        expect(extractPreviewProjectIdFromReferer(undefined)).toBeNull();
    });
});
