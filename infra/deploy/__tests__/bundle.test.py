import io
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

EXTRACT = Path(__file__).resolve().parents[1] / 'extract-bundle.py'

class BundleTest(unittest.TestCase):
    def extract(self, name, kind=tarfile.REGTYPE):
        content = io.BytesIO()
        with tarfile.open(fileobj=content, mode='w:gz') as archive:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.linkname = '/etc/shadow'
            member.size = 2 if kind == tarfile.REGTYPE else 0
            archive.addfile(member, io.BytesIO(b'{}') if member.size else None)
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, str(EXTRACT), directory], input=content.getvalue(), capture_output=True)
            if result.returncode == 0:
                self.assertEqual((Path(directory) / name).read_bytes(), b'{}')
                self.assertEqual(os.stat(Path(directory) / name).st_mode & 0o777, 0o644)
            return result.returncode

    def test_public_config_is_readable_by_non_root_containers(self):
        self.assertEqual(self.extract('config/ai-platforms.json'), 0)

    def test_rejects_traversal_absolute_paths_secrets_and_links(self):
        for name in ('../escape', '/etc/shadow', 'config/.env', 'root/.ssh/authorized_keys'):
            with self.subTest(name=name):
                self.assertNotEqual(self.extract(name), 0)
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind):
                self.assertNotEqual(self.extract('config/unsafe', kind), 0)

if __name__ == '__main__':
    unittest.main()
