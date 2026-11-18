import importlib.util
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'mixed-load-test.py'
spec = importlib.util.spec_from_file_location('mixed_load', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
RUN = str(uuid.uuid4())


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        if '/events?' in self.path:
            old = json.dumps({'runId': 'old', 'type': 'assistant.final'})
            delta = json.dumps({'runId': RUN, 'type': 'assistant.delta'})
            final = json.dumps({'runId': RUN, 'type': 'assistant.final'})
            body = ('data: ' + old + '\n\ndata: ' + delta + '\n\ndata: ' + final + '\n\n').encode()
            self.send_response(200); self.end_headers(); self.wfile.write(body)
        else:
            self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
    def do_POST(self):
        self.rfile.read(int(self.headers['Content-Length']))
        self.send_response(202); self.end_headers(); self.wfile.write(json.dumps({'runId': RUN}).encode())


class MixedLoadTest(unittest.TestCase):
    def test_duplicate_accounts_rejected(self):
        a = {'token': 'private', 'conversation_id': str(uuid.uuid4()), 'cursor': 0}
        with self.assertRaises(ValueError): module.validate({'base_url': 'https://example.test', 'accounts': [a, a]}, 2, False)

    def test_read_and_ai_filter_previous_final_and_hide_secret(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8') as f:
                json.dump({'base_url': 'http://127.0.0.1:' + str(server.server_port), 'accounts': [
                    {'token': 'secret-value', 'conversation_id': str(uuid.uuid4()), 'note_id': str(uuid.uuid4()), 'cursor': 0}]}, f); f.flush()
                os.chmod(f.name, 0o600)
                proc = subprocess.run([sys.executable, str(SCRIPT), '--fixture', f.name, '--users', '1',
                                       '--duration', '1', '--think-ms', '100', '--ai', '--allow-http'],
                                      capture_output=True, text=True, timeout=10)
                self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
                self.assertNotIn('secret-value', proc.stdout + proc.stderr)
                report = json.loads(proc.stdout)
                self.assertGreater(report['read_requests'], 0)
                self.assertEqual(report['ai'][0]['status'], 'assistant.final')
                self.assertIsNotNone(report['ai'][0]['first_delta_ms'])
                self.assertIn('/v2/notes/:id/reader', report['read_by_path'])
                os.chmod(f.name, 0o644)
                denied = subprocess.run([sys.executable, str(SCRIPT), '--fixture', f.name, '--allow-http'],
                                        capture_output=True, text=True, timeout=5)
                self.assertEqual(denied.returncode, 2)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_signal_emits_partial_report(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8') as f:
                json.dump({'base_url': 'http://127.0.0.1:' + str(server.server_port), 'accounts': [
                    {'token': 'secret-value', 'conversation_id': str(uuid.uuid4()), 'cursor': 0}]}, f); f.flush()
                os.chmod(f.name, 0o600)
                proc = subprocess.Popen([sys.executable, str(SCRIPT), '--fixture', f.name, '--duration', '30',
                                         '--allow-http'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                time.sleep(.8); proc.send_signal(signal.SIGINT)
                out, err = proc.communicate(timeout=5)
                self.assertEqual(proc.returncode, 1, err)
                self.assertTrue(json.loads(out)['interrupted'])
                self.assertNotIn('secret-value', out + err)
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__': unittest.main()
