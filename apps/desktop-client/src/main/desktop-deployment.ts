import { readFileSync } from 'node:fs';
import { deploymentConfigSchema } from '@astella/shared/desktop-ipc-contracts';

/** Installed public defaults; runtime overrides support development and smoke tests. */
export function desktopDeploymentEnvironment(env: NodeJS.ProcessEnv, path?: string): NodeJS.ProcessEnv {
  if (!path) return env;
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0) return env;
  const config = deploymentConfigSchema.parse(data);
  if (config.mode !== 'remote_https') throw new Error('Installer defaults must use HTTPS');
  return {
    DESKTOP_API_ORIGIN: config.apiOrigin,
    ASTELLA_DOMAIN_SCHEMA_REVISION: config.expectedDomainSchemaRevision,
    DESKTOP_DEPLOYMENT_CONFIG_REVISION: config.configRevision,
    ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== '')),
  };
}
