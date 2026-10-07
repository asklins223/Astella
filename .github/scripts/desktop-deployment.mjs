#!/usr/bin/env node
// Only these public connection fields may enter the installer. Never copy .env.
import { writeFileSync } from 'node:fs';
const origin = process.env.DESKTOP_API_ORIGIN?.trim();
let config = {};
if (origin) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) {
    throw new Error('Packaged deployments require an exact HTTPS origin');
  }
  const revision = process.env.ASTELLA_DOMAIN_SCHEMA_REVISION?.trim();
  if (!revision) throw new Error('ASTELLA_DOMAIN_SCHEMA_REVISION is required');
  config = { version: 1, mode: 'remote_https', apiOrigin: origin,
    expectedDomainSchemaRevision: revision, configRevision: 'desktop-production-v1' };
}
writeFileSync(new URL('../../apps/desktop-client/build/deployment.json', import.meta.url), JSON.stringify(config, null, 2) + '\n');
