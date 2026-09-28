export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Same dark palette as the app (constants/theme.ts in the Expo project). */
const STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #07080a; color: #e8eaed; font: 16px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  a { color: #8ea2ff; }
  .wrap { max-width: 560px; margin: 0 auto; padding: 24px 16px 48px; }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 800; letter-spacing: -0.02em; color: #f7f8fa; margin-bottom: 20px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #5b7cff; box-shadow: 0 0 10px #5b7cff; }
  .brand span { color: #8ea2ff; }
  h1 { font-size: 28px; line-height: 1.15; letter-spacing: -0.02em; color: #f7f8fa; margin: 0 0 8px; }
  h2 { font-size: 18px; color: #f7f8fa; margin: 28px 0 8px; }
  p, li { color: #a3a8b2; }
  .muted { color: #8a909b; font-size: 14px; }
`;

export function page(params: {
  title: string;
  head?: string;
  body: string;
  extraStyles?: string;
}): string {
  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#07080a" />
  <title>${escapeHtml(params.title)}</title>
  ${params.head ?? ''}
  <style>${STYLES}${params.extraStyles ?? ''}</style>
</head>
<body>
  <div class="wrap">
    <div class="brand"><div class="dot"></div>Night<span>Hub</span></div>
    ${params.body}
  </div>
</body>
</html>`;
}
