#!/bin/bash
set -euo pipefail
cd /Users/asklins/Documents/asklins_workspace/astella/astella-service_client
set -a
. ./.env
set +a
export AI_PLATFORMS_CONFIG="$PWD/config/ai-platforms.json"
eval "$(python3 - <<'PYS'
import json,shlex
from pathlib import Path
c=json.loads(Path('outputs/agent-no-bypass-2026-10-30/temporary-db.json').read_text());p=c['port'];d=c['database']
for k,v in dict(DATABASE_URL=f'postgres://astella@127.0.0.1:{p}/{d}',DATABASE_URL_MIGRATOR=f'postgres://astella@127.0.0.1:{p}/{d}',DATABASE_URL_WORKER=f'postgres://astella_worker:isolated_test_only@127.0.0.1:{p}/{d}',DATABASE_URL_API=f'postgres://astella_api:isolated_test_only@127.0.0.1:{p}/{d}',NODE_ENV='test',COMPANION_AGENT_RESOURCE_ROUTING='enabled').items():print('export '+k+'='+shlex.quote(v))
PYS
)"
cd workers/ai-worker
exec node --import tsx ../../outputs/agent-no-bypass-2026-10-30/run-runtime-live.mts
