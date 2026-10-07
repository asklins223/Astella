#!/usr/bin/env python
"""Extract the small deployment bundle; never accept links or private files."""
from __future__ import print_function
import os
import sys
import tarfile

destination = sys.argv[1]
archive = tarfile.open(fileobj=getattr(sys.stdin, 'buffer', sys.stdin), mode="r|gz")
allowed_files = {"docker-compose.yml", "docker-compose.deploy.yml", "deployment-images.env"}
allowed_prefixes = ("config/", "infra/postgres/", "infra/deploy/")
for member in archive:
    path = member.name
    parts = path.split("/")
    if path.startswith("/") or ".." in parts or any(part.startswith(".env") for part in parts):
        raise ValueError("Unsafe deployment path")
    if not (member.isfile() or member.isdir()):
        raise ValueError("Deployment links and special files are forbidden")
    if not (path in allowed_files or path.startswith(allowed_prefixes) or path in ("config", "infra", "infra/postgres", "infra/deploy")):
        raise ValueError("Unexpected deployment file")
    if member.size > 5 * 1024 * 1024:
        raise ValueError("Deployment file exceeds size limit")
    target = os.path.join(destination, path)
    if member.isdir():
        if not os.path.isdir(target):
            os.makedirs(target)
        os.chmod(target, 0o755)
        continue
    parent = os.path.dirname(target)
    if not os.path.isdir(parent):
        os.makedirs(parent)
    os.chmod(parent, 0o755)
    with open(target, "wb") as output:
        source = archive.extractfile(member)
        output.write(source.read())
    # Bundle contents are public configuration; API containers run as node.
    os.chmod(target, 0o644)
