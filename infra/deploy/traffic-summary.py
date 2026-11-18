#!/usr/bin/env python3
"""Summarize completed Nginx traffic records from stdin, without user data."""
import json
import sys


def summarize(lines):
    groups = {}
    for line in lines:
        try:
            event = json.loads(line)
            if not isinstance(event, dict) or event.get("astella_traffic") != 1:
                continue
            route = event["route"]
            status = event["status"]
            fields = ("request_bytes", "response_body_bytes", "response_bytes")
            if not isinstance(route, str) or type(status) is not int or not 100 <= status <= 599:
                continue
            if any(type(event.get(field)) is not int or event[field] < 0 for field in fields):
                continue
        except (ValueError, KeyError, TypeError):
            continue
        group = groups.setdefault(route, {"requests": 0, "errors_4xx": 0, "errors_5xx": 0,
                                           **{field: 0 for field in fields}})
        group["requests"] += 1
        group["errors_4xx"] += 400 <= status < 500
        group["errors_5xx"] += 500 <= status < 600
        for field in fields:
            group[field] += event[field]
    return dict(sorted(groups.items()))


if __name__ == "__main__":
    json.dump(summarize(sys.stdin), sys.stdout, indent=2)
    print()
