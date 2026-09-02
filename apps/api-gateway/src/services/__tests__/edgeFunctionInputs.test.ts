import { describe, it, expect } from 'vitest';
import { extractParamKeys } from '../edgeFunctionInputs.js';

describe('extractParamKeys', () => {
  it('reads dotted, bracketed and destructured access', () => {
    const code = `
      const { action, payload = {}, userId: uid } = params;
      if (params.limit > 10) throw new Error('too many');
      const q = params['search'] ?? params["page"];
      return { ok: true };
    `;
    expect(extractParamKeys(code)).toEqual(['action', 'limit', 'page', 'payload', 'search', 'userId']);
  });

  it('ignores rest spreads and other objects that merely contain "params"', () => {
    const code = `
      const { first, ...others } = params;
      const { deep: { x } } = params;
      const notParams = other.params.value;
      const mine = myparams.also;
      const settings = { params: 1 };
    `;
    expect(extractParamKeys(code)).toEqual(['deep', 'first']);
  });

  it('returns nothing for a function that takes no input', () => {
    expect(extractParamKeys('return await db.select("listings");')).toEqual([]);
    expect(extractParamKeys('')).toEqual([]);
  });
});
