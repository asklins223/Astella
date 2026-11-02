#!/usr/bin/env python3
"""Publish synthetic reply/transport evidence; omit copied persona and reasoning."""
import argparse
import hashlib
import json
import pathlib
import re
import statistics

ROOT = next(p for p in pathlib.Path(__file__).resolve().parents if (p / 'workers/ai-worker/package.json').exists())
OUT = ROOT / 'docs/testing/evidence/agent-conversation-fixes-2026-11-01'

def metrics(records):
    def stat(field, fn):
        values = [r[field] for r in records if isinstance(r.get(field), (int, float))]
        return round(fn(values), 1) if values else None
    return {'turns': len(records), 'succeeded': sum(r.get('status') == 'succeeded' for r in records),
        'firstVisibleMedianMs': stat('firstVisibleMs', statistics.median),
        'firstVisibleMaxMs': stat('firstVisibleMs', max), 'totalMedianMs': stat('totalMs', statistics.median),
        'totalMaxMs': stat('totalMs', max), 'queueMedianMs': stat('queueMs', statistics.median),
        'finishContractFailures': sum(s.get('error') == 'FINISH_CONTRACT_INCOMPLETE' for r in records for s in r.get('steps', [])),
        'mainProviderCalls': sum(c.get('operation', '').startswith('companion_agent:')
            or c.get('operation', '').startswith('companion_agent_fallback:') for r in records for c in r.get('providerCalls', []))}

def delivery(record):
    events = record.get('events', [])
    utterances = [e['payload']['text'] for e in events if e['type'] == 'assistant.utterance']
    public = '\n\n'.join(utterances) if utterances else ''.join(e['payload']['textDelta'] for e in events if e['type'] == 'assistant.delta')
    finals = [e['payload'] for e in events if e['type'] == 'assistant.final']
    digest = hashlib.sha256(record.get('reply', '').encode()).hexdigest()
    return {'sseMatchesSaved': public == record.get('reply'),
        'finalHashMatchesSaved': finals[-1].get('textSha256') == digest if finals else None,
        'savedTextSha256': digest}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dialogue', action='append', required=True)
    parser.add_argument('--persona', required=True)
    parser.add_argument('--matrix', required=True)
    parser.add_argument('--matrix-log', required=True)
    args = parser.parse_args()
    groups, transcripts = {}, []
    for filename in args.dialogue + [args.persona]:
        data = json.loads((ROOT / filename).read_text())
        expected = 4 if filename == args.persona else 10
        assert len(data['records']) == expected and all(r.get('status') == 'succeeded' for r in data['records']), filename
        groups[data['label']] = metrics(data['records'])
        for record in data['records']:
            item = {k: record.get(k) for k in ['name','input','runId','status','model','provider','promptVersion',
                'stepCount','toolCallCount','firstVisibleMs','totalMs','queueMs','calls','steps']}
            item.update(delivery(record))
            item['group'] = data['label']
            if filename == args.persona:
                item['replyChars'] = len(record.get('reply', ''))
                item['replyOmitted'] = 'Copied real persona: aggregate evidence only; profile and generated text stay private.'
            else:
                item['reply'] = record.get('reply')
            transcripts.append(item)
    log = pathlib.Path(args.matrix_log).read_text()
    start = re.search(r'\{\s*"result":', log)
    assert start, 'matrix summary is missing'
    matrix_summary, _ = json.JSONDecoder().raw_decode(log[start.start():])
    matrix = json.loads((ROOT / args.matrix).read_text())
    assert matrix_summary['result'] == 'pass' and matrix_summary['passed'] == 14 and len(matrix['records']) == 14
    matrix_items = [{k:r.get(k) for k in ['name','runId','terminal','elapsedMs','messageCount','evidence']} for r in matrix['records']]
    review = OUT / 'quality-review.json'
    summary = {'date': '2026-11-01', 'scope': 'Local real HTTP/worker/model; not deployed; synthetic accounts.',
        'groups': groups, 'delivery': {'turns': len(transcripts),
            'sseSaveMismatches': sum(not r['sseMatchesSaved'] for r in transcripts),
            'finalHashMismatches': sum(r['finalHashMatchesSaved'] is False for r in transcripts)},
        'matrix': matrix_summary,
        'quality': json.loads(review.read_text()) if review.exists() else {'status': 'manual review required; delivery success is not a knowledge-accuracy score',
            'note': 'Earlier iterations include fabricated scenes, unsolicited advice and incorrect knowledge elaboration. Those are retained privately and described in the implementation report.'}}
    OUT.mkdir(exist_ok=True)
    for name, value in [('summary', summary), ('synthetic-transcripts', transcripts), ('task-matrix', matrix_items)]:
        (OUT / (name+'.json')).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'groups': groups, 'delivery': summary['delivery'], 'matrixPassed': matrix_summary['passed']},ensure_ascii=False))

if __name__ == '__main__': main()
