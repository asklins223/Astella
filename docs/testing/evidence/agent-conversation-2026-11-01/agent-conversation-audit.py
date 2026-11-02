#!/usr/bin/env python3
"""真实 HTTP/worker 日常对话审计；独立账号，凭据不落盘，不自动确认操作。

时间分别保留客户端 SSE、服务端持久事件、运行终态，避免把回复完成当成首字。
生产 SQL 仅通过已经授权并建立的 SSH control socket；本脚本不处理 SSH 密码。
"""
from __future__ import annotations
import argparse
import collections
import hashlib
import json
import pathlib
import subprocess
import threading
import time
import urllib.request
import uuid

ROOT = next(parent for parent in pathlib.Path(__file__).resolve().parents
            if (parent / 'workers/ai-worker/package.json').is_file())
CASES = [
    ("greeting", "嗨，下午好啊"),
    ("small-share", "刚下楼买咖啡，店员在杯子上画了只特别潦草的猫，笑死"),
    ("followup", "像一颗长了耳朵的土豆哈哈哈"),
    ("mood", "今天其实有点累，啥都不想干"),
    ("constraint", "不用安慰我，也别给我安排事情，就随便聊两句"),
    ("news", "你今天有什么想跟我分享的吗"),
    ("correction", "你这话有点像客服了，正常说话就行"),
    ("minimal", "嗯"),
    ("knowledge", "顺便问下，为什么咖啡放凉了会更苦？简单说就行"),
    ("closing", "行啦，我去吃饭了，回头聊"),
]
PRESENCE_CASES = [
    ("call-name", "小肥鱼"),
    ("correct-inference", "谁说你吵了？我没说你吵啊"),
    ("plain-chat", "我就是想找你聊两句"),
    ("no-filler", "你不用每次都强调不催我、不打扰我，接着话说就行"),
    ("new-topic", "楼下有只橘猫，胖得像个煤气罐，还非要往小纸箱里钻"),
    ("topic-followup", "屁股卡在外面了，它还以为自己藏得挺好"),
    ("simple-answer", "对了，为什么冰会浮在水上？两句话就好"),
    ("minimal", "哦哦，懂了"),
    ("change-topic", "那个猫先不聊了。今天在家躺了一下午，还挺舒服的"),
    ("closing", "我去洗澡了，待会再聊"),
]
PERSONA_CASES = [
    ("call-name", "小肥鱼"),
    ("plain-chat", "我就是想找你聊两句"),
    ("new-topic", "今天在家躺了一下午，还挺舒服的"),
    ("closing", "我去洗澡了，待会再聊"),
]
NATURAL_CASES = [
    ("alarm", "睡醒发现手机掉床缝里了，闹钟还在里面响"),
    ("late", "掏出来一看，再过五分钟就迟到了"),
    ("arrival", "赶上了，差点把鞋跑丢"),
    ("rest", "这会儿总算能坐着喝口水了"),
    ("after-work", "今天就想早点下班回家打游戏"),
    ("knowledge", "哦对，太阳落山后天空为什么有时还是亮的？两句就够"),
    ("ack", "原来是这样"),
    ("fridge", "刚看了一眼冰箱，只剩一根黄瓜"),
    ("dinner", "算了我去楼下吃碗面"),
    ("bye", "吃完再来，先走啦"),
]

def quote(value):
    return "'" + str(value).replace("'", "''") + "'"

class Audit:
    def __init__(self, args):
        self.args = args
        self.base = args.base.rstrip("/")
        self.uid, self.wid = str(uuid.uuid4()), str(uuid.uuid4())
        self.token = uuid.uuid4().hex + uuid.uuid4().hex
        self.conv = None
        self.events, self.records, self.active, self.stream_errors = [], [], [], []
        self.stop = threading.Event()
        self.output = pathlib.Path(args.out)
        self.output.parent.mkdir(parents=True, exist_ok=True)
        self.started = time.time()
        self.seeded = False

    def sql(self, sql):
        psql = ["docker", "exec", "-i", self.args.container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "astella", "-d", "astella"]
        cmd = psql if self.args.arm == "local" else ["ssh", "-S", self.args.socket, "-o", "BatchMode=yes", "-p", "11587", "root@103.106.191.159", " ".join(psql)]
        scope = f"BEGIN; SET LOCAL statement_timeout='12s'; SET LOCAL app.workspace_id={quote(self.wid)}; SET LOCAL app.user_id={quote(self.uid)};\n"
        done = subprocess.run(cmd, input=scope + sql + "\nCOMMIT;\n", text=True, capture_output=True, timeout=25)
        if done.returncode:
            raise RuntimeError("scoped SQL failed: " + done.stderr[-500:])
        return [json.loads(line) for line in done.stdout.splitlines() if line.startswith(("{", "["))]

    def api(self, path, body=None):
        req = urllib.request.Request(self.base + path, method="GET" if body is None else "POST",
            data=None if body is None else json.dumps(body).encode(), headers={"authorization": "Bearer " + self.token,
            "content-type": "application/json", "Idempotency-Key": str(uuid.uuid4())})
        with urllib.request.urlopen(req, timeout=25) as res:
            return json.load(res)

    def persist(self):
        self.output.write_text(json.dumps({"version": 1, "arm": self.args.arm, "label": self.args.label,
            "startedAt": self.started, "suite": self.args.suite, "userId": self.uid,
            "personaExperiment": ('trimmed-self-description' if self.args.trim_learned_persona else 'full-profile') if self.args.persona_file else None,
            "workspaceId": self.wid, "conversationId": self.conv,
            "note": "Synthetic isolated account; production HTTP and worker path; no automatic confirmations. No tokens saved.",
            "records": self.records, "streamErrors": self.stream_errors}, ensure_ascii=False, indent=2))

    def subscribe(self):
        cursor = 0
        while not self.stop.is_set():
            try:
                req = urllib.request.Request(f"{self.base}/companion/conversations/{self.conv}/events?after={cursor}",
                    headers={"authorization": "Bearer " + self.token, "accept": "text/event-stream"})
                with urllib.request.urlopen(req, timeout=30) as res:
                    while not self.stop.is_set():
                        raw = res.readline()
                        if not raw: break
                        if raw.startswith(b"data:"):
                            event = json.loads(raw[5:])
                            cursor = max(cursor, int(event.get("seq", 0)))
                            self.events.append((time.monotonic(), event))
            except Exception as exc:
                if not self.stop.is_set(): self.stream_errors.append({"error": type(exc).__name__, "at": time.time()})
            self.stop.wait(1)

    def turn(self, name, text):
        start = time.monotonic()
        accepted = self.api(f"/companion/conversations/{self.conv}/turns", {"version": 1, "clientMessageId": str(uuid.uuid4()),
            "inputKind": "text", "sourceSurface": "pet", "blocks": [{"type": "text", "text": text}]})
        rid = accepted["runId"]
        self.active.append(accepted)
        record = {"name": name, "input": text, "runId": rid, "acceptedMs": round((time.monotonic()-start)*1000)}
        self.records.append(record)
        self.persist()
        while time.monotonic() - start < 150:
            rows = self.sql(f"SELECT json_build_object('status',status,'error',error_code) FROM companion_turn_runs WHERE id={quote(rid)} AND user_id={quote(self.uid)};")
            state = rows[0] if rows else {}
            if state.get("status") not in ("accepted", "running", "cancel_requested"):
                break
            time.sleep(0.6)
        record.update(self.sql(f"""SELECT json_build_object('status',r.status,'error',r.error_code,
          'model',r.model_id,'provider',r.provider_id,'promptVersion',r.prompt_version,'stepCount',r.step_count,
          'modelCallCount',r.model_call_count,'toolCallCount',r.tool_call_count,
          'totalMs',round(extract(epoch FROM r.finished_at-r.created_at)*1000),
          'queueMs',round(extract(epoch FROM r.started_at-r.created_at)*1000),
          'firstVisibleMs',(SELECT round(extract(epoch FROM min(e.created_at)-r.created_at)*1000) FROM companion_stream_events e WHERE e.run_id=r.id AND e.type IN ('assistant.delta','assistant.utterance')),
          'messages',(SELECT coalesce(json_agg(json_build_object('id',id,'blocks',blocks) ORDER BY seq),'[]'::json) FROM companion_messages WHERE run_id=r.id AND role='assistant'),
          'events',(SELECT coalesce(json_agg(json_build_object('seq',seq,'type',type,'ms',round(extract(epoch FROM created_at-r.created_at)*1000),'payload',CASE WHEN type='assistant.thinking' THEN jsonb_build_object('textLength',length(payload->>'text')) ELSE payload END) ORDER BY seq),'[]'::json) FROM companion_stream_events WHERE run_id=r.id),
          'calls',(SELECT coalesce(json_agg(json_build_object('name',name,'status',status,'risk',risk_class) ORDER BY created_at),'[]'::json) FROM companion_agent_tool_calls WHERE run_id=r.id),
          'steps',(SELECT coalesce(json_agg(json_build_object('step',step_no,'status',status,'error',error_code,'ms',round(extract(epoch FROM finished_at-started_at)*1000)) ORDER BY step_no),'[]'::json) FROM companion_agent_steps WHERE run_id=r.id),
          'providerCalls',(SELECT coalesce(json_agg(json_build_object('provider',provider,'model',model_id,'operation',operation,'durationMs',duration_ms,'promptTokens',prompt_tokens,'completionTokens',completion_tokens,'status',status) ORDER BY created_at),'[]'::json) FROM ai_audit_log WHERE job_id=r.job_id)
        ) FROM companion_turn_runs r WHERE r.id={quote(rid)} AND r.user_id={quote(self.uid)};""")[0])
        mine = [(t,e) for t,e in self.events if e.get("runId") == rid]
        visible = [t for t,e in mine if e.get("type") in ("assistant.delta", "assistant.utterance")]
        record["clientFirstVisibleMs"] = round((min(visible)-start)*1000) if visible else None
        record["reply"] = "\n\n".join("".join(b.get("text", "") for b in m["blocks"] if b.get("type") in ("text","markdown")) for m in record["messages"])
        self.persist()
        print(json.dumps({k:record.get(k) for k in ["name","status","firstVisibleMs","totalMs","modelCallCount","reply"]},ensure_ascii=False),flush=True)
        if record["status"] != "succeeded":
            raise RuntimeError("Turn did not succeed: " + str(record["status"]))
        time.sleep(max(0, 5.2-(time.monotonic()-start)))

    def run(self):
        q=quote
        try:
            self.sql(f"""INSERT INTO users(id,email,password_hash,role) VALUES({q(self.uid)},{q('audit-1101-'+self.uid+'@test.invalid')},'synthetic-no-login','owner');
            INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES({q(self.wid)},{q('Agent日常对话审计1101 '+self.args.label)},{q(self.uid)},'personal');
            INSERT INTO workspace_members(workspace_id,user_id,role) VALUES({q(self.wid)},{q(self.uid)},'owner');
            UPDATE users SET personal_workspace_id={q(self.wid)} WHERE id={q(self.uid)};
            INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES({q(self.uid)},'ai-consent-v1',now(),'{{"sendToExternal":true,"sendImageContent":false,"piiDetection":false,"auditLogging":true}}'::jsonb);
            INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES({q(self.uid)},0,true);
            INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at) VALUES({q(hashlib.sha256(self.token.encode()).hexdigest())},{q(self.uid)},{q(self.wid)},'desktop',now()+interval '2 hours');""")
            self.seeded = True
            if self.args.persona_file:
                if self.args.arm != 'local':
                    raise ValueError('Persona attribution experiments are local-only')
                profile = json.loads(pathlib.Path(self.args.persona_file).read_text())[0]['profile']
                if self.args.trim_learned_persona:
                    profile = {**profile, 'selfDescription': ''}
                self.sql(f"INSERT INTO companion_persona_profiles(user_id,revision,profile) VALUES({q(self.uid)},1,{q(json.dumps(profile,ensure_ascii=False))}::jsonb);")
            self.conv = self.api('/companion/inbox/ensure', {})['id']
            self.persist()
            threading.Thread(target=self.subscribe,daemon=True).start()
            for name,text in {'coffee':CASES,'presence':PRESENCE_CASES,'persona':PERSONA_CASES,'natural':NATURAL_CASES}[self.args.suite][:self.args.limit]:
                self.turn(name,text)
        finally:
            self.stop.set()
            for run in self.active:
                try:
                    self.api('/companion/runs/'+run['runId']+'/cancel', {'version':1,'generation':run['generation'],'reason':'user'})
                except Exception: pass
            if self.seeded:
                self.sql(f"UPDATE user_companion_account_state SET global_enabled=false,epoch=epoch+1 WHERE user_id={q(self.uid)}; DELETE FROM sessions WHERE user_id={q(self.uid)};")
            self.persist()

if __name__ == '__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--arm',choices=['local','online'],required=True)
    p.add_argument('--label',required=True)
    p.add_argument('--base',required=True)
    p.add_argument('--out',required=True)
    p.add_argument('--suite', choices=['coffee','presence','persona','natural'], default='coffee')
    p.add_argument('--persona-file')
    p.add_argument('--limit', type=int, default=None)
    p.add_argument('--trim-learned-persona', action='store_true')
    p.add_argument('--container',default='astella-dev-postgres-1')
    p.add_argument('--socket',default='/tmp/astella-review-1101-control')
    Audit(p.parse_args()).run()
