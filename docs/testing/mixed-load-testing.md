# Mixed server load testing

`scripts/mixed-load-test.py` generates a bounded, closed-loop workload through the public HTTPS entrypoint. Each user repeatedly reads a note list, note cache version, workspace list and authentication capabilities, with a configurable pause after each response. With `--ai`, each user also submits exactly one concurrent companion turn while those reads run. The AI option creates messages, jobs, audit records and external-provider charges; use dedicated test accounts only. The tool neither creates nor deletes accounts or their data.

Prepare an isolated environment or explicitly authorized target. Give each user a separate test account and conversation, a current session token, and enough representative notes and other content to match the scenario. Enable AI consent and external-provider access for each account if testing AI. Supplying each account's `note_id` adds a note reader page to the read mix. Images, audio, WebSockets, downloads and writes are not covered; run separate tests for those paths. Record fixture data sizes, client location, versions, network path and any background traffic alongside results. Do not infer a user capacity from empty accounts or a single short run.

Put the following JSON in a private local file outside Git and set `chmod 600` on it. Replace the examples; never commit or share the file. `cursor` is the latest event sequence for that conversation before the test; an expired cursor can make the SSE stream return 409. Each user must have a distinct token and conversation. The tool does not log tokens, account identifiers, response bodies or prompts.

```json
{
  "base_url": "https://example.test",
  "accounts": [
    {"token": "REPLACE", "conversation_id": "00000000-0000-4000-8000-000000000001", "cursor": 0,
     "note_id": "00000000-0000-4000-8000-000000000002"}
  ]
}
```

Run one stage at a time, wait for jobs to drain and inspect service health before moving up. Supply enough different accounts for the selected stage. Start with a read-only baseline, then select the AI flag when AI calls and their cost are intended. For example:

```sh
python3 scripts/mixed-load-test.py --fixture /private/path/fixture.json --users 1 --duration 60
python3 scripts/mixed-load-test.py --fixture /private/path/fixture.json --users 4 --duration 60 --ai
```

Increase users gradually only while latency, errors, resource use and queue wait meet the intended service objective. The tool caps a stage at 50 accounts and 300 seconds by default; `--extended` permits up to 1800 seconds. It enforces at least 100 ms between each user's reads, and defaults to one user and a one-second pause. SIGINT or SIGTERM stops new requests and emits the partial report; in-flight HTTP requests can take up to 20 seconds to finish and the SSE read up to 30 seconds. `--allow-http` permits HTTP only for loopback development targets. HTTPS certificates are always verified; redirects are rejected to prevent leaking credentials. Each read uses a fresh HTTP connection, so its handshake and connection pressure differ from persistent client connections. Each stage reports per-path and aggregate p50/p95, HTTP statuses and compressed response-body bytes; it excludes HTTP headers, TLS and TCP overhead. AI reports client-observed first delta and final times by test slot, filtering SSE events by run ID. A 409 stream error can mean the fixture cursor is stale. Errors and stream failures return a nonzero exit status.

Save the nonsecret JSON output together with service and database CPU, RSS, network RX/TX, event-loop delay, database connections, AI queue depth/oldest wait and provider errors. Compare equivalent workloads and versions. The timer includes the final AI wait, which can exceed the read duration. Results represent only the selected endpoint mix and client network; the tool does not itself measure a capacity limit or prove sustained production readiness.
