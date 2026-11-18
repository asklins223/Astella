#!/usr/bin/env python3
"""Bounded mixed read/companion load against explicitly provisioned test accounts.

The input file is secret: {"base_url":"https://host", "accounts":[
 {"token":"...", "conversation_id":"uuid", "cursor":0}, ...]}. Each account
must be a separate disposable user with a live session, current event cursor,
AI consent and representative read-only data. No users or data are created or
removed. Output contains aggregate timings and status codes only.
"""
import argparse
import concurrent.futures
import json
import math
import os
import signal
import stat
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import Counter

READ_PATHS = ("/notes?limit=20", "/client-cache/notes/version", "/auth/workspaces", "/v1/auth/capabilities")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never forward a fixture's bearer token to a redirect destination.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect())


def percentile(samples, p):
    ordered = sorted(samples)
    return round(ordered[max(0, math.ceil(p * len(ordered)) - 1)] * 1000, 1) if ordered else None


def validate(config, count, allow_http):
    base = config.get("base_url", "").rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
        raise ValueError("base_url must contain only a scheme, host and optional port")
    if parsed.scheme != "https" and not (allow_http and parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")):
        raise ValueError("HTTPS is required except explicit loopback --allow-http")
    accounts = config.get("accounts")
    if not isinstance(accounts, list) or len(accounts) < count:
        raise ValueError("one disposable account is required per concurrent user")
    tokens, conversations = set(), set()
    for item in accounts[:count]:
        if not isinstance(item, dict) or not isinstance(item.get("token"), str) or not item["token"]:
            raise ValueError("each account needs a token")
        try:
            conv = str(uuid.UUID(item["conversation_id"]))
        except (ValueError, KeyError, TypeError, AttributeError):
            raise ValueError("each account needs a conversation UUID") from None
        cursor = item.get("cursor")
        if not isinstance(cursor, int) or isinstance(cursor, bool) or cursor < 0:
            raise ValueError("each account needs a nonnegative current event cursor")
        if item["token"] in tokens or conv in conversations:
            raise ValueError("accounts must use distinct tokens and conversations")
        if "note_id" in item:
            try:
                uuid.UUID(item["note_id"])
            except (ValueError, TypeError, AttributeError):
                raise ValueError("note_id must be a UUID") from None
        tokens.add(item["token"]); conversations.add(conv)
    return base


def request(base, account, path, method="GET", payload=None, extra=None, timeout=20):
    headers = {"Authorization": "Bearer " + account["token"], "Accept-Encoding": "gzip" if method == "GET" else "identity"}
    if extra: headers.update(extra)
    data = json.dumps(payload).encode() if payload is not None else None
    if data is not None: headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with OPENER.open(req, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        exc.close()
        return exc.code, b""


def reader(base, account, duration, think, start, stop):
    start.wait(); end = time.monotonic() + duration
    results = []
    i = 0
    paths = [(path, path) for path in READ_PATHS]
    if account.get("note_id"):
        paths.append(("/v2/notes/:id/reader", "/v2/notes/" + account["note_id"] + "/reader"))
    while time.monotonic() < end and not stop.is_set():
        label, path = paths[i % len(paths)]; i += 1
        begin = time.monotonic()
        try:
            code, data = request(base, account, path)
            results.append((label, str(code), time.monotonic() - begin, len(data)))
        except (OSError, ValueError):
            results.append((label, "network_error", time.monotonic() - begin, 0))
        remaining = end - time.monotonic()
        if remaining > 0: stop.wait(min(think, remaining))
    return results


def ai_turn(base, account, start, stop, timeout):
    start.wait(); begin = time.monotonic()
    if stop.is_set(): return {"status": "interrupted"}
    cid = account["conversation_id"]
    body = {"version": 1, "clientMessageId": str(uuid.uuid4()), "inputKind": "text",
            "blocks": [{"type": "text", "text": "你好，请简单问候我一句。"}], "sourceSurface": "pet"}
    try:
        code, data = request(base, account, "/companion/conversations/" + cid + "/turns", "POST", body,
                             {"Idempotency-Key": str(uuid.uuid4())})
        accepted = time.monotonic() - begin
        if code not in (200, 201, 202): return {"status": "http_" + str(code)}
        run = json.loads(data).get("runId")
        if not run: return {"status": "missing_run"}
        path = "/companion/conversations/" + cid + "/events?after=" + str(account["cursor"])
        req = urllib.request.Request(base + path, headers={"Authorization": "Bearer " + account["token"], "Accept": "text/event-stream"})
        first = None
        with OPENER.open(req, timeout=min(timeout, 30)) as stream:
            for raw in stream:
                if stop.is_set(): return {"status": "interrupted"}
                elapsed = time.monotonic() - begin
                if elapsed > timeout: return {"status": "timeout"}
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"): continue
                event = json.loads(line[5:].strip())
                if event.get("runId") != run: continue
                if event.get("type") == "assistant.delta" and first is None: first = elapsed
                if event.get("type") in ("assistant.final", "error"):
                    return {"status": event["type"], "accepted_ms": round(accepted * 1000, 1),
                            "first_delta_ms": round(first * 1000, 1) if first is not None else None,
                            "finished_ms": round(elapsed * 1000, 1)}
        return {"status": "stream_closed"}
    except urllib.error.HTTPError as exc:
        return {"status": "stream_http_" + str(exc.code)}
    except (OSError, ValueError, json.JSONDecodeError):
        return {"status": "network_or_stream_error"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", required=True, help="path to private JSON fixture")
    parser.add_argument("--users", type=int, default=1, help="number of distinct users (1–50)")
    parser.add_argument("--duration", type=int, default=30, help="read phase seconds (1–300; up to 1800 with --extended)")
    parser.add_argument("--extended", action="store_true", help="allow a read phase longer than 300 seconds")
    parser.add_argument("--think-ms", type=int, default=1000, help="pause between requests per user (minimum 100 ms)")
    parser.add_argument("--ai", action="store_true", help="send exactly one AI turn per user; writes data and incurs provider costs")
    parser.add_argument("--ai-timeout", type=int, default=120, help="AI stream timeout seconds (10–300)")
    parser.add_argument("--allow-http", action="store_true", help="permit HTTP only on loopback")
    args = parser.parse_args()
    if not (1 <= args.users <= 50 and 1 <= args.duration <= (1800 if args.extended else 300) and 100 <= args.think_ms <= 60000 and 10 <= args.ai_timeout <= 300):
        parser.error("requested load exceeds safety bounds")
    try:
        info = os.stat(args.fixture)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ValueError("fixture must be a private regular file (chmod 600)")
        with open(args.fixture, encoding="utf-8") as f: config = json.load(f)
        base = validate(config, args.users, args.allow_http)
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        print("Invalid fixture: " + str(exc), file=sys.stderr); return 2
    accounts = config["accounts"][:args.users]
    start = threading.Event()
    stop = threading.Event()
    def interrupt(_signum, _frame):
        stop.set()
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.users * (2 if args.ai else 1)) as pool:
        readers = [pool.submit(reader, base, a, args.duration, args.think_ms / 1000, start, stop) for a in accounts]
        turns = [pool.submit(ai_turn, base, a, start, stop, args.ai_timeout) for a in accounts] if args.ai else []
        started = time.monotonic(); start.set()
        reads = [item for f in readers for item in f.result()]
        ai_results = [f.result() for f in turns]
    report = {"users": args.users, "read_duration_s": args.duration, "wall_s": round(time.monotonic() - started, 2),
              "think_ms": args.think_ms, "read_requests": len(reads),
              "interrupted": stop.is_set(),
              "read_status": dict(Counter(row[1] for row in reads)),
              "read_p50_ms": percentile([row[2] for row in reads], .50),
              "read_p95_ms": percentile([row[2] for row in reads], .95),
              "read_wire_body_bytes": sum(row[3] for row in reads),
              "read_by_path": {p: {"requests": len(rows), "status": dict(Counter(r[1] for r in rows)),
                                    "p50_ms": percentile([r[2] for r in rows], .50),
                                    "p95_ms": percentile([r[2] for r in rows], .95), "wire_body_bytes": sum(r[3] for r in rows)}
                               for p in (*READ_PATHS, "/v2/notes/:id/reader") for rows in [[r for r in reads if r[0] == p]] if rows},
              "ai": ai_results}
    print(json.dumps(report, indent=2))
    return 1 if stop.is_set() or any(row[1] != "200" for row in reads) or any(x["status"] != "assistant.final" for x in ai_results) else 0


if __name__ == "__main__":
    sys.exit(main())
