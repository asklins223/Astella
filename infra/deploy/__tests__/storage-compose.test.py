"""Validate the resolved environment boundary, not just Compose source strings."""
import json
import os
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[3]

class StorageComposeTest(unittest.TestCase):
    def resolve(self, files, storage=False):
        environment = dict(os.environ)
        for name in files:
            for variable in re.findall(r'\$\{([A-Z0-9_]+):\?', (ROOT / name).read_text()):
                environment[variable] = 'disposable-test-placeholder'
        for name in ['DATABASE_URL_API', 'DATABASE_URL_WORKER', 'DATABASE_URL_MIGRATOR']:
            environment[name] = 'postgres://qa:qa@postgres:5432/qa'
        environment.update(STORAGE_MODE='remote', STORAGE_BACKUP_ENABLED='true',
            STORAGE_ENDPOINT='https://cloud.invalid', STORAGE_ACCESS_KEY_ID='qa-access',
            STORAGE_SECRET_ACCESS_KEY='qa-secret', MINIO_ROOT_USER='qa-minio', MINIO_ROOT_PASSWORD='qa-minio-secret')
        for name in ['API_IMAGE', 'WORKER_IMAGE', 'EDGE_TTS_IMAGE', 'EMBEDDING_IMAGE', 'BACKUP_IMAGE']:
            environment[name] = 'qa-image'
        command = ['docker', 'compose']
        for name in files:
            command += ['-f', name]
        if storage:
            command += ['--profile', 'storage']
        result = subprocess.run(command + ['config', '--format', 'json'], cwd=ROOT,
            env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, 'Compose configuration must resolve')
        return json.loads(result.stdout)['services']

    def test_development_is_one_local_store_even_with_production_env_present(self):
        services = self.resolve(['docker-compose.dev.yml'], storage=True)
        self.assertIn('minio', services)
        self.assertNotIn('backup-minio', services)
        for name in ['api', 'worker']:
            config = services[name]['environment']
            self.assertEqual(config['STORAGE_MODE'], 'local')
            self.assertEqual(config['STORAGE_BACKUP_ENABLED'], 'false')
            self.assertEqual(config['STORAGE_ENDPOINT'], 'http://minio:9000')
        self.assertEqual(services['minio']['build']['dockerfile'], 'infra/storage-backup/Dockerfile')
        self.assertEqual(services['minio-init']['build']['dockerfile'], 'infra/storage-backup/Dockerfile.client')

    def test_alpha_keeps_one_local_store(self):
        services = self.resolve(['docker-compose.yml', 'docker-compose.alpha.yml'], storage=True)
        self.assertIn('minio', services)
        self.assertNotIn('backup-minio', services)
        for name in ['api', 'worker']:
            self.assertEqual(services[name]['environment']['STORAGE_MODE'], 'local')
            self.assertEqual(services[name]['environment']['STORAGE_BACKUP_ENABLED'], 'false')

    def test_production_overlay_adds_cloud_primary_and_private_local_standby(self):
        services = self.resolve(['docker-compose.yml', 'docker-compose.deploy.yml', 'infra/deploy/docker-compose.storage-backup.yml'])
        self.assertNotIn('minio', services)
        self.assertIn('backup-minio', services)
        for name in ['api', 'worker']:
            self.assertEqual(services[name]['environment']['STORAGE_MODE'], 'remote')
            self.assertEqual(services[name]['environment']['STORAGE_BACKUP_ENABLED'], 'true')
            self.assertEqual(services[name]['environment']['STORAGE_BACKUP_ENDPOINT'], 'http://backup-minio:9000')
        self.assertEqual(services['api']['environment']['STORAGE_BACKUP_BYTES_PER_SECOND'], '262144')
        self.assertEqual(services['api']['environment']['STORAGE_BACKUP_START_HOUR_UTC8'], '2')
        self.assertEqual(services['api']['environment']['STORAGE_BACKUP_END_HOUR_UTC8'], '6')
        self.assertFalse(services['backup-minio'].get('ports'))
        self.assertEqual(int(services['backup-minio']['mem_limit']), 512 * 1024 * 1024)
        self.assertEqual(float(services['backup-minio']['cpus']), 0.5)

if __name__ == '__main__':
    unittest.main()
