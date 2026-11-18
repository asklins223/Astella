import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("traffic_summary", Path(__file__).resolve().parents[2] / "infra/deploy/traffic-summary.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class TrafficSummaryTest(unittest.TestCase):
    def test_aggregates_completed_requests_and_ignores_other_logs(self):
        def record(route, status, received, body, sent):
            return json.dumps(dict(astella_traffic=1, route=route, status=status,
                                   request_bytes=received, response_body_bytes=body, response_bytes=sent))
        result = module.summarize([
            record("uploads", 200, 100, 200, 300), record("uploads", 404, 20, 0, 30),
            record("storage_backup", 503, 50, 5, 50), '{"status":200}', 'not json',
            record("uploads", 200, -1, 2, 3),
        ])
        self.assertEqual(result["uploads"], dict(requests=2, errors_4xx=1, errors_5xx=0,
                                                  request_bytes=120, response_body_bytes=200, response_bytes=330))
        self.assertEqual(result["storage_backup"]["errors_5xx"], 1)


if __name__ == "__main__":
    unittest.main()
