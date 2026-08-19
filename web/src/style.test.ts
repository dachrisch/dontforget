import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// `fileURLToPath(import.meta.url)` throws ERR_INVALID_URL_SCHEME under this
// project's Vitest/Vite setup (import.meta.url here isn't a plain file:
// URL) — .pathname is the working alternative, verified against the actual
// test run rather than assumed from convention.
const __dirname = dirname(new URL(import.meta.url).pathname);
const css = readFileSync(resolve(__dirname, './style.css'), 'utf-8');

describe('style.css', () => {
  it('defines the light paper-and-ink token palette', () => {
    expect(css).toContain('--paper: #f7f3e9;');
    expect(css).toContain('--ink: #1f1b16;');
    expect(css).toContain('--accent: #a4302a;');
  });

  it('overrides tokens for dark mode inside the prefers-color-scheme block', () => {
    const darkBlockMatch = css.match(/@media \(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\s*\}\n\}/);
    expect(darkBlockMatch).not.toBeNull();
    const darkBlock = darkBlockMatch![1];
    expect(darkBlock).toContain('--paper: #1c1a16;');
    expect(darkBlock).toContain('--accent: #d9714f;');
  });

  it('self-hosts the display font instead of loading it from a CDN', () => {
    expect(css).toContain('@font-face');
    expect(css).toContain('/fonts/playfair-display-700.woff2');
    expect(css).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  it('defines the shared state-transition animation', () => {
    expect(css).toMatch(/@keyframes\s+workspace-enter/);
    expect(css).toContain('.workspace-enter');
  });

  it('hides the error banner when [hidden], overriding its own display: flex', () => {
    // .error-banner sets `display: flex` for its message/dismiss-button
    // layout. Author styles beat the UA [hidden] stylesheet regardless of
    // selector specificity, so without this override the banner stays
    // visible (empty, with just the dismiss ×) even when JS sets
    // `errorBanner.hidden = true`.
    expect(css).toMatch(/\.error-banner\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
  });

  it('gives .link-button (Edit/Delete/Sign out) a touch target tall enough for WCAG 2.5.8, without shifting text position', () => {
    // .link-button has no visible background/border, so real padding would
    // be invisible anyway — but naive padding would also push neighboring
    // text apart. An equal-and-opposite negative margin cancels that, so
    // the fix must pair the two or it either does nothing (no padding) or
    // shifts layout (unmatched padding/margin).
    const rule = css.match(/\.link-button\s*\{([\s\S]*?)\}/)?.[1];
    expect(rule).toBeDefined();
    const padding = rule!.match(/padding:\s*([\d.]+)rem\s+0;/)?.[1];
    const margin = rule!.match(/margin:\s*-([\d.]+)rem\s+0;/)?.[1];
    expect(padding).toBeDefined();
    expect(margin).toBe(padding);
    // 12px font, ~13.6px line box measured in a real browser: padding alone
    // must add enough on both edges to clear the 24px minimum.
    expect(Number(padding) * 2 * 16 + 13.6).toBeGreaterThanOrEqual(24);
  });

  it('ships the actual Latin-subset font file, not a stripped/wrong subset', () => {
    const fontPath = resolve(__dirname, '../public/fonts/playfair-display-700.woff2');
    const { size } = statSync(fontPath);
    // The Latin subset of Playfair Display 700 is ~23KB. Other Unicode
    // subsets Google's API also serves for this family (e.g. cyrillic,
    // ~12KB) contain no Latin glyphs, so every element using
    // --font-display would silently fall back to its fallback font with
    // no visible error — this guards against re-downloading the wrong one.
    expect(size).toBeGreaterThan(20000);
  });
});
