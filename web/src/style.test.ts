import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(new URL(import.meta.url).pathname);
const css = readFileSync(resolve(__dirname, './style.css'), 'utf-8');

describe('style.css', () => {
  it('defines the light paper-and-ink token palette', () => {
    expect(css).toContain('--paper: #f7f3e9;');
    expect(css).toContain('--ink: #1f1b16;');
    expect(css).toContain('--accent: #a4302a;');
  });

  it('overrides tokens for dark mode', () => {
    expect(css).toMatch(/prefers-color-scheme:\s*dark/);
    expect(css).toContain('--paper: #1c1a16;');
    expect(css).toContain('--accent: #d9714f;');
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
});
