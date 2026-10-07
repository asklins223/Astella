import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { desktopDeploymentEnvironment } from '../desktop-deployment';
const directories: string[] = [];
function fixture(data: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'astella-deployment-'));
  directories.push(directory);
  const path = join(directory, 'deployment.json');
  writeFileSync(path, JSON.stringify(data));
  return path;
}
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
const config = { version: 1, mode: 'remote_https', apiOrigin: 'https://192.0.2.1',
  expectedDomainSchemaRevision: 'domain-v1', configRevision: 'release-v1' };
it('uses installed HTTPS defaults without a machine .env', () => {
  expect(desktopDeploymentEnvironment({}, fixture(config)).DESKTOP_API_ORIGIN).toBe(config.apiOrigin);
});
it('preserves runtime smoke overrides and empty development defaults', () => {
  const env = { DESKTOP_API_ORIGIN: 'http://127.0.0.1:4000' };
  expect(desktopDeploymentEnvironment(env, fixture(config)).DESKTOP_API_ORIGIN).toBe(env.DESKTOP_API_ORIGIN);
  expect(desktopDeploymentEnvironment(env, fixture({}))).toBe(env);
});
it('rejects credentials, unknown secret fields and plain HTTP', () => {
  expect(() => desktopDeploymentEnvironment({}, fixture({ ...config, apiOrigin: 'http://192.0.2.1' }))).toThrow();
  expect(() => desktopDeploymentEnvironment({}, fixture({ ...config, apiOrigin: 'https://user:pass@example.com' }))).toThrow();
  expect(() => desktopDeploymentEnvironment({}, fixture({ ...config, API_KEY: 'private' }))).toThrow();
});
