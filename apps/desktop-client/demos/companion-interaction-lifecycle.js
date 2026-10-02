/* Transient papers share one clock; conversation records never expire. */
(() => {
  function lifetimeFor(block) {
    if (block.type === "proposal") return ["pending","confirming"].includes(block.state) ? Infinity : 10000;
    if (block.type === "tool") return block.state === "running" ? 60000 : 8000;
    if (block.type === "image" || block.type === "card") return 90000;
    return 60000;
  }
  function create({ onExpire,now = () => performance.now(),schedule = setTimeout,cancel = clearTimeout }) {
    const items = new Map();
    let timer = 0, hidden = false;
    function settle() {
      const time = now();
      for (const item of items.values()) {
        if (!hidden) item.remaining -= Math.max(0,time-Math.max(item.at,item.pauseUntil));
        item.at = time;
      }
    }
    function arm() {
      cancel(timer); timer = 0;
      if (hidden) return;
      const time = now();
      const delays = [...items.values()].filter((item) => Number.isFinite(item.remaining)).map((item) => Math.max(0,item.remaining)+Math.max(0,item.pauseUntil-time));
      if (!delays.length) return;
      timer = schedule(() => {
        settle(); const expired = [];
        for (const [id,item] of items) if (item.remaining <= 0) { items.delete(id); expired.push(id); }
        if (expired.length) onExpire(expired);
        arm();
      },Math.max(1,Math.min(...delays)));
    }
    return {
      update(entries) {
        settle(); const time = now(), active = new Set(entries.map((entry) => entry.id));
        for (const id of items.keys()) if (!active.has(id)) items.delete(id);
        for (const entry of entries) {
          const old = items.get(entry.id);
          if (!old || old.signature !== entry.signature) items.set(entry.id,{ signature:entry.signature,remaining:entry.duration,at:time,pauseUntil:0 });
        }
        arm();
      },
      activity(id) {
        settle(); const item = items.get(id);
        if (item) item.pauseUntil = now()+2500;
        arm();
      },
      setHidden(value) { settle(); hidden = value; arm(); },
      clear() { cancel(timer); timer = 0; items.clear(); },
    };
  }
  window.COMPANION_DEMO_LIFECYCLE = { create,lifetimeFor };
})();
