// Leaf module (no imports from bootstrap.ts / app.module.ts on purpose) so it can be
// imported both by bootstrap.ts (CORS setup) and by CsrfOriginGuard (Origin allow-list
// check on the cookie-authenticated auth endpoints) without creating a module import
// cycle back through AppModule.
export function resolveCorsOrigins(): string[] {
  const fromEnv = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (fromEnv.length) return fromEnv;

  return [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
  ];
}
