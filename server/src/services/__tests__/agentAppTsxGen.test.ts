import { describe, it, expect } from 'vitest';
import { generateAppTsxFromPages, deriveRoutePath } from '../agentAppTsxGen.js';

describe('generateAppTsxFromPages', () => {
  it('wires a home page and a normal page', () => {
    const tsx = generateAppTsxFromPages(['src/pages/HomePage.tsx', 'src/pages/AboutPage.tsx']);
    expect(tsx).toContain('<Route path="/" element={<HomePage />} />');
    expect(tsx).toContain('<Route path="/about" element={<AboutPage />} />');
  });

  it('throws instead of silently shadowing a duplicate route', () => {
    // "ContactUsPage" and "Contact-UsPage" both derive to "/contact-us".
    expect(() =>
      generateAppTsxFromPages(['src/pages/ContactUsPage.tsx', 'src/pages/Contact-UsPage.tsx']),
    ).toThrow(/duplicate route/i);
  });
});

describe('deriveRoutePath', () => {
  it('routes home/index/landing to "/"', () => {
    expect(deriveRoutePath('HomePage')).toBe('/');
    expect(deriveRoutePath('LandingPage')).toBe('/');
  });

  it('kebab-cases everything else', () => {
    expect(deriveRoutePath('ContactUsPage')).toBe('/contact-us');
    expect(deriveRoutePath('PricingPage')).toBe('/pricing');
  });
});
