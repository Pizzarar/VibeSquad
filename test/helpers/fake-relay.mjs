// In-memory untrusted relay for the E5 tests (test/relay-tunnel.test.mjs, test/relay-wiring.test.mjs). `Sock` is used as
// the WebSocket implementation for both the host (role=host) and clients (role=client); it routes opaque frames only,
// records every frame (`frames`) and lets a test tamper with them (`mutate`) or drop the host (`dropHost`). No network.
export function makeRelay() {
  const relay = { frames: [], host: null, clients: new Map(), hostConnects: 0, mutate: null, nextCid: 1 };
  class Sock {
    constructor(url) {
      const q = new URL(url).searchParams;
      this.role = q.get("role");
      this.readyState = 0;
      this.l = {};
      queueMicrotask(() => {
        this.readyState = 1;
        if (this.role === "host") {
          relay.host = this;
          relay.hostConnects++;
        } else {
          this.cid = `c${relay.nextCid++}`;
          relay.clients.set(this.cid, this);
          relay.host?.fire("message", { data: JSON.stringify({ t: "open", cid: this.cid }) });
        }
        this.fire("open", {});
      });
    }
    addEventListener(t, fn) {
      (this.l[t] ||= []).push(fn);
    }
    fire(t, ev) {
      for (const fn of this.l[t] ?? []) fn(ev);
    }
    send(data) {
      let dir = this.role === "host" ? "h2c" : "c2h";
      let raw = String(data);
      relay.frames.push({ dir, raw });
      if (relay.mutate) {
        raw = relay.mutate(dir, raw, this.cid);
        if (raw == null) return;
      }
      const f = JSON.parse(raw);
      queueMicrotask(() => {
        if (dir === "c2h") relay.host?.fire("message", { data: JSON.stringify({ ...f, cid: this.cid }) });
        else relay.clients.get(f.cid)?.fire("message", { data: JSON.stringify(f.t === "close" ? { t: "close" } : { t: "msg", b: f.b }) });
        if (dir === "h2c" && f.t === "close") relay.clients.get(f.cid)?.fire("close", {});
      });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.role === "host") {
        if (relay.host === this) relay.host = null;
        this.fire("close", {});
      } else {
        relay.clients.delete(this.cid);
        relay.host?.fire("message", { data: JSON.stringify({ t: "close", cid: this.cid }) });
        this.fire("close", {});
      }
    }
  }
  relay.Sock = Sock;
  relay.dropHost = () => relay.host?.close();
  return relay;
}
