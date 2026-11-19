import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";

const knownFamilies = [
  ["GPT", /^(gpt[-.]|chatgpt|o[134](?:-|$))/i],
  ["Claude", /^claude/i],
  ["DeepSeek", /^deepseek/i],
  ["Gemini", /^gemini/i],
  ["Qwen", /^qwen/i],
  ["Kimi", /^(kimi|k[23][.-])/i],
  ["GLM", /^glm/i],
  ["Grok", /^grok/i],
  ["MiniMax", /^minimax/i],
  ["MiMo", /^mimo/i],
  ["Llama", /^llama/i],
  ["Mistral", /^(mistral|ministral|magistral)/i],
  ["Step", /^step[-.]/i],
];
const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);
// Only product/model identifiers reach storage. Discard account-like labels and URLs.
const label = (s) =>
  typeof s === "string" &&
  /^[\p{L}\p{N}._:/ -]{1,160}$/u.test(s) &&
  !s.includes("://")
    ? s.trim()
    : "";
// Magpie Record.Decode / DecodeOf. Compute once, keep only its two summable measures.
function decode(r) {
  let out = count(r.out),
    begin = count(r.ttft_ms);
  if (!begin || (r.reasoning_hidden && !r.first_text_ms)) return [null, null];
  if (r.reasoning > 0) {
    if (r.first_text_ms > 0) {
      out -= r.reasoning;
      begin = r.first_text_ms;
    } else if (
      r.first_reasoning_ms >= begin &&
      r.flow_ms > 0 &&
      r.reasoning <= out
    )
      begin = r.first_reasoning_ms;
    else return [null, null];
  }
  const window = count(r.ms) - begin;
  if (
    !(out > 0 && window >= 100) ||
    1000 * out > 10000 * window ||
    (r.flow_ms > 0 && 4 * r.flow_ms < window) ||
    (window < 1000 && begin > 4 * window) ||
    (r.reasoning > 0 &&
      r.first_text_ms > 0 &&
      out * (begin - r.ttft_ms) > 20 * r.reasoning * window)
  )
    return [null, null];
  return [out, window];
}
export function project(r) {
  if (["probe", "search", "mcp"].includes(r.source) || r.kind === "model_list")
    return null;
  const t =
    typeof r.t === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(r.t)
      ? Date.parse(r.t)
      : NaN;
  if (!Number.isFinite(t)) return null;
  const reportedModel = label(r.served);
  const model = reportedModel || label(r.model) || "未知模型";
  const family = /(?:^|\/)group\//i.test(model)
    ? null
    : knownFamilies.find(([, re]) => re.test(model.split("/").at(-1)));
  const client = label(r.client) || label(r.agent);
  const status = count(r.status);
  let outcome = "未知";
  if (r.canceled || (status === 499 && r.err_type === "agent_canceled"))
    outcome = "取消";
  else if (r.rejected || status >= 400 || r.err) outcome = "错误";
  else if (status >= 200 && status < 300) outcome = "完成";
  const origin =
    r.computer && r.origin === "gateway"
      ? "shared"
      : ["gateway", "session", "reported"].includes(r.origin)
        ? r.origin
        : "unknown";
  return [
    r.id,
    t,
    origin,
    client && !["other", "local", "unknown"].includes(client.toLowerCase())
      ? client
      : "未知客户端",
    model,
    family?.[0] || "未分类",
    +!!reportedModel,
    +!r.handed_on,
    outcome,
    +!!r.rejected,
    count(r.in),
    count(r.out),
    count(r.cache_read),
    count(r.cache_write),
    count(r.ms),
    ...decode(r),
  ];
}

export class Ledger {
  constructor(file) {
    if (file !== ":memory:") {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      closeSync(openSync(file, "a", 0o600));
      chmodSync(file, 0o600);
    }
    this.db = new Database(file, { create: true });
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sync(singleton INTEGER PRIMARY KEY CHECK(singleton=1), active INT, writing INT, cursor TEXT, updated INT, skipped INT);
      INSERT OR IGNORE INTO sync VALUES(1,0,1,'start',0,0);
      CREATE TABLE IF NOT EXISTS events(gen INT,id TEXT,t INT,origin TEXT,client TEXT,model TEXT,family TEXT,served INT,request INT,outcome TEXT,rejected INT,input INT,output INT,cr INT,cw INT,ms INT,decodeOut INT,decodeMs INT,PRIMARY KEY(gen,id));
      CREATE INDEX IF NOT EXISTS event_time ON events(gen,t);`);
    this.put = this.db.prepare(
      "INSERT OR REPLACE INTO events VALUES(" +
        Array(18).fill("?").join(",") +
        ")",
    );
  }
  state() {
    return this.db.query("SELECT * FROM sync").get();
  }
  reset(expected) {
    this.db
      .transaction(() => {
        const s = this.state();
        if (s.cursor !== expected) return;
        const gen = s.active + 1;
        this.db.query("DELETE FROM events WHERE gen=?").run(gen);
        this.db
          .query("UPDATE sync SET writing=?,cursor='start',skipped=0")
          .run(gen);
      })
      .immediate();
  }
  apply(expected, page) {
    if (
      !Array.isArray(page.rows) ||
      !Array.isArray(page.deleted) ||
      typeof page.has_more !== "boolean" ||
      !page.next_cursor ||
      typeof page.next_cursor !== "string" ||
      (page.has_more && expected === page.next_cursor)
    )
      throw Error("feed 格式不兼容");
    this.db
      .transaction(() => {
        const s = this.state();
        if (s.cursor !== expected) return;
        let skipped = 0;
        const remove = this.db.query("DELETE FROM events WHERE gen=? AND id=?");
        for (const r of page.rows) {
          if (!/^u_[0-9a-f]+$/.test(r.id)) throw Error("feed 行标识异常");
          const row = project(r);
          if (row) this.put.run(s.writing, ...row);
          else {
            remove.run(s.writing, r.id);
            skipped++;
          }
        }
        for (const gone of page.deleted) remove.run(s.writing, gone.id);
        const active = page.has_more ? s.active : s.writing;
        this.db
          .query(
            "UPDATE sync SET cursor=?,active=?,updated=?,skipped=skipped+?",
          )
          .run(
            page.next_cursor,
            active,
            page.has_more ? s.updated : Date.now(),
            skipped,
          );
        if (active !== s.active)
          this.db.query("DELETE FROM events WHERE gen<>?").run(active);
      })
      .immediate();
  }
}
