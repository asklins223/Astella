import argparse,datetime,os,importlib.util,json,pathlib,threading,time,uuid
root=next(parent for parent in pathlib.Path(__file__).resolve().parents if (parent/'workers/ai-worker/package.json').is_file())
spec=importlib.util.spec_from_file_location('audit',root/'docs/testing/evidence/agent-conversation-2026-11-01/agent-conversation-audit.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.CASES=[('startup-1','[宿主真实启动观察；没有用户消息]'),('startup-2','[新的应用启动；没有用户消息]'),('startup-3','[新的应用启动；没有用户消息]')]
class Probe(m.Audit):
    awareness=None
    def observe(self,topic,foreground=True):
        return super().api('/me/companion/awareness',{**self.awareness,'id':str(uuid.uuid4()),'topic':topic,
            'occurredAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'elapsedMs':0,
            'context':{**self.awareness['context'],'foreground':foreground}})
    def api(self,path,body=None):
        if path.endswith('/turns') and body is not None:
            if self.awareness: self.observe('context.updated',False)
            started=time.time()
            self.awareness={'version':1,'deviceSessionId':'quality-probe:'+str(uuid.uuid4()),'appLaunchId':str(uuid.uuid4()),'host':'desktop',
              'context':{'foreground':True,'unlocked':True,'typing':False,'learning':False,'participationAllowed':True,'conversationId':self.conv,
              'page':{'key':'home','label':'书房','revision':None,'context':None}}}
            accepted=self.observe('app.started')
            if not accepted['accepted']: raise RuntimeError('Awareness observation was not accepted')
            while time.time()-started<45:
                rows=self.sql(f"SELECT json_build_object('runId',id,'generation',generation) FROM companion_turn_runs WHERE user_id={m.quote(self.uid)} AND input_source IS NOT NULL AND created_at>=to_timestamp({started}) ORDER BY generation DESC LIMIT 1;")
                if rows:return rows[0]
                time.sleep(.4)
            raise RuntimeError('No actual startup run within 45 seconds')
        return super().api(path,body)
    def turn(self,name,text):
        original=super().turn
        heartbeat_stop=threading.Event()
        def heartbeat():
            while not heartbeat_stop.wait(10):
                if self.awareness:
                    try:self.observe('context.updated')
                    except Exception:pass
        thread=threading.Thread(target=heartbeat,daemon=True);thread.start()
        try:original(name,text)
        finally:heartbeat_stop.set();thread.join(timeout=1)
    def persist(self):
        super().persist()
        d=json.loads(self.output.read_text());d['suite']='actual-startup-observations';d['note']='Isolated synthetic account, actual HTTP awareness, queued initiative/worker/current model route/SSE and persisted message path. No user messages, canned model replies, provider override or auto confirmation.'
        self.output.write_text(json.dumps(d,ensure_ascii=False,indent=2))
args=argparse.Namespace(arm='local',base='http://127.0.0.1:4000',label=os.getenv('PROACTIVE_PROBE_LABEL','proactive-natural-v2'),suite='coffee',out=str(root/'outputs/audits/2026-11-01-agent-fixes'/(os.getenv('PROACTIVE_PROBE_LABEL','proactive-natural-v2')+'.json')),limit=None,persona_file=None,trim_learned_persona=False,container='astella-dev-postgres-1',socket='')
if __name__ == '__main__':
    Probe(args).run()
