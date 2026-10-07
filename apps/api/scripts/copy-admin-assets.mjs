import { cpSync, mkdirSync } from 'node:fs';

// The bundled CJS server resolves panel assets relative to dist/server.cjs.
const destination = new URL('../dist/static/', import.meta.url);
mkdirSync(destination, { recursive: true });
cpSync(new URL('../src/modules/admin/static/', import.meta.url), destination, {
  recursive: true,
});
