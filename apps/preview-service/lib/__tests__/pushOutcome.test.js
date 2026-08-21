import { test, expect, describe } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { decidePushOutcome } = require('../pushOutcome.js');

/**
 * The /update push decision, exhaustively. Three booleans is 8 cases, so all 8
 * are enumerated rather than sampled -- this is the logic standing between a
 * user and a broken preview, and "we tested the paths we thought of" is how
 * the 2026-08-18/19 incidents happened in the first place.
 */

describe('decidePushOutcome', () => {
    // hasBuildErrors, hasSnapshot, wouldReload -> attemptRollback, reload
    const cases = [
        // Clean pushes: promote. Reload only when the browser is showing
        // something that actually changed.
        [false, false, false, { attemptRollback: false, reload: false }],
        [false, false, true, { attemptRollback: false, reload: true }],
        [false, true, false, { attemptRollback: false, reload: false }],
        [false, true, true, { attemptRollback: false, reload: true }],
        // Broken pushes: never reload, roll back whenever there is a snapshot
        // to roll back to.
        [true, false, false, { attemptRollback: false, reload: false }],
        [true, false, true, { attemptRollback: false, reload: false }],
        [true, true, false, { attemptRollback: true, reload: false }],
        [true, true, true, { attemptRollback: true, reload: false }],
    ];

    for (const [hasBuildErrors, hasSnapshot, wouldReload, expected] of cases) {
        test(`errors=${hasBuildErrors} snapshot=${hasSnapshot} wouldReload=${wouldReload}`, () => {
            expect(decidePushOutcome({ hasBuildErrors, hasSnapshot, wouldReload })).toEqual(expected);
        });
    }

    test('THE invariant: a push with build errors never reloads, under any combination', () => {
        for (const hasSnapshot of [true, false]) {
            for (const wouldReload of [true, false]) {
                const outcome = decidePushOutcome({ hasBuildErrors: true, hasSnapshot, wouldReload });
                expect(
                    outcome.reload,
                    `reload must stay false for a broken push (snapshot=${hasSnapshot}, wouldReload=${wouldReload})`,
                ).toBe(false);
            }
        }
    });

    test('a clean push is never rolled back', () => {
        for (const hasSnapshot of [true, false]) {
            for (const wouldReload of [true, false]) {
                expect(
                    decidePushOutcome({ hasBuildErrors: false, hasSnapshot, wouldReload }).attemptRollback,
                ).toBe(false);
            }
        }
    });

    test('rollback is not attempted when there is no snapshot to restore', () => {
        expect(
            decidePushOutcome({ hasBuildErrors: true, hasSnapshot: false, wouldReload: true }).attemptRollback,
        ).toBe(false);
    });

    test('coerces undefined inputs to booleans rather than leaking them into the result', () => {
        // The route passes values derived from other calls; a stray undefined
        // must not become a truthy-ish reload decision downstream.
        expect(decidePushOutcome({ hasBuildErrors: false, hasSnapshot: undefined, wouldReload: undefined }))
            .toEqual({ attemptRollback: false, reload: false });
        expect(decidePushOutcome({ hasBuildErrors: true, hasSnapshot: undefined, wouldReload: undefined }))
            .toEqual({ attemptRollback: false, reload: false });
    });
});
