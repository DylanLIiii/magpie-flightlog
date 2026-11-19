import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, project } from "../lib/ledger.mjs";
import { gatewayURL, collector } from "../lib/collector.mjs";
import { metrics } from "../lib/metrics.mjs";
const start = Date.parse("2026-10-12T00:00:00Z"),
  day = 86400000;
const row = (id, t, extra = {}) => ({
  id: "u_" + id,
  t: new Date(start + t).toISOString(),
  status: 200,
  in: 10,
  out: 20,
  agent: "pi",
  origin: "gateway",
  served: "Claude-Sonnet",
  ms: 1000,
  ttft_ms: 500,
  ...extra,
});
const page = (rows, cursor, more = false, deleted = []) => ({
  rows,
  deleted,
  has_more: more,
  next_cursor: cursor,
});
const query = (ledger, p = {}) =>
  metrics(ledger.db, new URLSearchParams({ period: "1", ...p }), start + day);
test("时间边界、分钟峰值、TPS、继承并发和来源", () => {
  const l = new Ledger(":memory:");
  l.apply(
    "start",
    page(
      [
        row("a", -100),
        row("b", 0),
        row("c", 1000),
        row("d", 60000, { handed_on: true }),
        row("e", 61000, { source: "log", origin: "session", status: 0 }),
        row("f", day),
      ],
      "c",
    ),
  );
  const d = query(l);
  expect(d.totals.calls).toBe(3);
  expect(d.totals.tokens).toBe(120);
  expect(d.totals.peakRPM).toBe(2);
  expect(d.totals.peakTPM).toBe(60);
  expect(d.totals.tpm).toBe(120 / 1440);
  expect(d.totals.peak).toBe(2);
  expect(d.totals.speed).toBe(40);
  expect(d.origins.session).toBe(1);
  expect(d.outcomes["未知"]).toBe(1);
  expect(d.totals.timed).toBe(2);
  expect(d.previous).toBeNull();
});
test("同刻交接只算一个、缺失不会制造零速率", () => {
  const l = new Ledger(":memory:");
  l.apply(
    "start",
    page(
      [
        row("a", 0),
        row("b", 1000),
        row("c", 60000, {
          in: null,
          out: null,
          ms: 0,
          origin: "reported",
          client: "other",
          agent: "",
        }),
      ],
      "c",
    ),
  );
  expect(query(l).totals.peak).toBe(1);
  let d = query(l, { client: "未知客户端" });
  expect(d.totals.tpm).toBeNull();
  expect(d.totals.speed).toBeNull();
  expect(d.totals.peak).toBeNull();
  expect(d.totals.known).toBe(0);
  expect(query(l, { client: "none" }).totals.rpm).toBeNull();
});
test("游标持久化、旧页重放、改写、删除、重建原子切换", () => {
  const dir = mkdtempSync(join(tmpdir(), "flightlog-test-"));
  try {
    const path = join(dir, "metrics.sqlite");
    let l = new Ledger(path);
    l.apply("start", page([row("a", 0)], "A", true));
    expect(query(l).state.ready).toBeFalse();
    l.db.close();
    l = new Ledger(path);
    expect(l.state().cursor).toBe("A");
    l.apply("start", page([row("b", 0)], "A", true));
    l.apply("A", page([row("a", 0, { out: 70 }), row("c", 0)], "B"));
    l.apply("B", page([], "C", false, [{ id: "u_c" }]));
    expect(query(l).totals.tokens).toBe(80);
    l.reset("C");
    l.apply("start", page([row("f", 0)], "D", true));
    expect(query(l).totals.tokens).toBe(80);
    l.apply("D", page([], "E"));
    expect(query(l).totals.tokens).toBe(30);
    l.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("按家族、模型、Client 筛选；异常行不带出敏感字段", () => {
  const l = new Ledger(":memory:");
  l.apply(
    "start",
    page(
      [
        row("a", 0, {
          client: "editor",
          t: "2026-10-12T08:00:00+08:00",
          canceled: true,
          status: 499,
        }),
        row("b", 50, {
          origin: "unknown",
          status: 499,
          err: "sensitive-test-sentinel",
          rejected: true,
          served: "group/x",
        }),
        row("c", 100, { source: "mcp" }),
        row("d", 100, { t: "no timezone" }),
      ],
      "C",
    ),
  );
  expect(
    query(l, { family: "Claude", client: "editor", model: "Claude-Sonnet" })
      .outcomes["取消"],
  ).toBe(1);
  expect(query(l).outcomes["错误"]).toBe(1);
  expect(query(l).totals.rejected).toBe(1);
  expect(query(l).state.skipped).toBe(2);
  expect(JSON.stringify(query(l))).not.toContain("sensitive-test-sentinel");
  expect(project(row("a", 0, { served: "person@example.com" }))[6]).toBe(0);
});
test("feed 失效恢复、断网保留索引，网关仅本机", async () => {
  const l = new Ledger(":memory:");
  l.apply("start", page([row("b", 0)], "old"));
  let offline = false;
  const c = collector(l, gatewayURL(), async (url) => {
    if (offline) throw Error();
    if (String(url).endsWith("concurrency"))
      return Response.json({ requests: 0 });
    if (new URL(url).searchParams.get("cursor") === "old")
      return Response.json(
        { error: { code: "cursor_expired" } },
        { status: 410 },
      );
    return Response.json(page([row("c", 0, { status: 403 })], "new"));
  });
  await c.sync();
  expect(l.state().cursor).toBe("new");
  expect(query(l).outcomes["错误"]).toBe(1);
  offline = true;
  await c.sync();
  expect(c.info.error).toBeTruthy();
  expect(query(l).totals.calls).toBe(1);
  expect(() => gatewayURL("example.org:3425")).toThrow();
});
test("解码排除缓冲突发，并扣除首文本前的推理输出", () => {
  const l = new Ledger(":memory:");
  l.apply(
    "start",
    page(
      [
        row("a", 0, { ms: 501, ttft_ms: 500, out: 6000 }),
        row("b", 10, {
          reasoning: 30,
          out: 80,
          first_text_ms: 1200,
          ms: 2200,
          ttft_ms: 900,
        }),
        row("c", 20, { reasoning_hidden: true }),
      ],
      "ok",
    ),
  );
  const d = query(l);
  expect(d.totals.speedRows).toBe(1);
  expect(d.totals.speedPeak).toBe(50);
  expect(d.totals.speed).toBe(50);
});
test("等长前期与无历史窗口", () => {
  const l = new Ledger(":memory:");
  l.apply("start", page([row("a", -day), row("b", 0), row("c", 1000)], "ok"));
  const d = query(l);
  expect(d.previous.calls).toBe(1);
  expect(d.previous.tokens).toBe(30);
  expect(d.totals.calls).toBe(2);
  expect(d.totals.tokens).toBe(60);
  expect(query(l, { period: "all" }).previous).toBeNull();
  expect(query(l, { period: "30" }).previous).toBeNull();
});
test("共享机器的网关流量可归因，但不抬高本机并发", () => {
  const l = new Ledger(":memory:");
  l.apply(
    "start",
    page([row("a", 0), row("b", 0, { computer: "another" })], "ok"),
  );
  const d = query(l);
  expect(d.totals.calls).toBe(2);
  expect(d.totals.peak).toBe(1);
  expect(d.origins.shared).toBe(1);
  expect(d.totals.timed).toBe(1);
});
