const minute = 60000,
  day = 86400000;
const dimensions = ["family", "model", "client"];
const valid = (n) => Number.isFinite(n);
const plus = (a, b) => (b == null ? a : (a ?? 0) + b);

export function metrics(db, params = new URLSearchParams(), now = Date.now()) {
  return db.transaction(() => read(db, params, now))();
}
function read(db, p, now) {
  const state = db.query("SELECT * FROM sync").get();
  const gen = state.active;
  const { first, last } = db
    .query("SELECT MIN(t) first,MAX(t) last FROM events WHERE gen=? AND t<?")
    .get(gen, now);
  const period = ["1", "7", "14", "30", "all"].includes(p.get("period"))
    ? p.get("period")
    : "7";
  const start =
    period === "all" ? (first ?? now - day) : now - Number(period) * day;
  const filters = Object.fromEntries(
    dimensions.map((k) => [k, p.get(k) || ""]),
  );
  const group = dimensions.includes(p.get("group")) ? p.get("group") : "family";
  const opts = {};
  // The model list follows the selected family. Other menus stay switchable.
  for (const k of dimensions) {
    const byFamily = k === "model" && filters.family;
    opts[k] = db
      .query(
        `SELECT DISTINCT ${k} value FROM events WHERE gen=? ${byFamily ? "AND family=?" : ""} ORDER BY value`,
      )
      .all(gen, ...(byFamily ? [filters.family] : []))
      .map((r) => r.value);
  }
  if (filters.family && filters.model && !opts.model.includes(filters.model))
    filters.model = "";
  const chosen = dimensions.filter((k) => filters[k]);
  const condition = chosen.map((k) => " AND " + k + "=?").join("");
  const args = chosen.map((k) => filters[k]);
  const fetchRows = (a, b) =>
    db
      .query(
        `SELECT t,ms,decodeOut,decodeMs,origin,request,outcome,rejected,input,output,cr,cw,served,client,model,family FROM events WHERE gen=? AND t<? AND (t>=? OR (request=1 AND origin='gateway' AND t+ms>?))${condition} ORDER BY t`,
      )
      .iterate(gen, b, a, a, ...args);
  const current = summarize(fetchRows(start, now), start, now, group);
  let previous = null;
  if (period !== "all" && first != null && first <= start - (now - start)) {
    previous = summarize(
      fetchRows(start - (now - start), start),
      start - (now - start),
      start,
      group,
    ).totals;
  }
  return {
    period,
    start,
    now,
    first,
    last,
    filters,
    opts,
    group,
    previous,
    state: {
      ready: !!gen,
      rebuilding: gen !== state.writing,
      updated: state.updated,
      skipped: state.skipped,
    },
    ...current,
  };
}
export function summarize(rows, start, end, group) {
  const width = Math.max(1, (end - start) / 48);
  const bins = Array.from({ length: 48 }, (_, i) => ({
    t: start + i * width,
    calls: 0,
    tokens: null,
    peak: null,
    rows: 0,
  }));
  const totals = {
    calls: 0,
    rows: 0,
    tokens: null,
    input: null,
    output: null,
    cr: null,
    cw: null,
    tokenRows: 0,
    timed: 0,
    known: 0,
    served: 0,
    rejected: 0,
    speedRows: 0,
    speed: null,
    speedPeak: null,
    peak: null,
    rpm: null,
    tpm: null,
    peakRPM: null,
    peakTPM: null,
  };
  const outcomes = { 完成: 0, 取消: 0, 错误: 0, 未知: 0 };
  const origins = {
    gateway: 0,
    shared: 0,
    session: 0,
    reported: 0,
    unknown: 0,
  };
  const groups = new Map(),
    minutes = new Map(),
    days = new Set(),
    edges = [];
  let speedMs = 0,
    speedOut = 0;
  const index = (t) =>
    Math.max(0, Math.min(47, Math.floor((t - start) / width)));
  for (const r of rows) {
    const timed = r.request && r.origin === "gateway" && r.ms > 0;
    if (timed && r.t < end && r.t + r.ms > start)
      edges.push([Math.max(start, r.t), 1], [Math.min(end, r.t + r.ms), -1]);
    if (r.t < start || r.t >= end) continue;
    const bin = bins[index(r.t)],
      m = Math.floor(r.t / minute);
    const bucket = minutes.get(m) ?? { calls: 0, tokens: null };
    minutes.set(m, bucket);
    const g = groups.get(r[group]) ?? {
      name: r[group],
      calls: 0,
      tokens: null,
    };
    groups.set(g.name, g);
    totals.rows++;
    bin.rows++;
    days.add(Math.floor(r.t / day));
    for (const k of ["input", "output", "cr", "cw"])
      totals[k] = plus(totals[k], r[k]);
    if (r.input != null && r.output != null) {
      const tokens = r.input + r.output;
      totals.tokenRows++;
      totals.tokens = plus(totals.tokens, tokens);
      g.tokens = plus(g.tokens, tokens);
      bin.tokens = plus(bin.tokens, tokens);
      bucket.tokens = plus(bucket.tokens, tokens);
    }
    if (!r.request) continue;
    totals.calls++;
    bin.calls++;
    bucket.calls++;
    g.calls++;
    outcomes[r.outcome]++;
    origins[r.origin]++;
    totals.timed += Number(!!timed);
    totals.known += Number(r.client !== "未知客户端");
    totals.served += r.served;
    totals.rejected += r.rejected;
    if (timed && r.outcome === "完成" && r.decodeMs > 0) {
      speedOut += r.decodeOut;
      speedMs += r.decodeMs;
      totals.speedRows++;
      totals.speedPeak = Math.max(
        totals.speedPeak ?? 0,
        (1000 * r.decodeOut) / r.decodeMs,
      );
    }
  }
  if (speedMs) totals.speed = (1000 * speedOut) / speedMs;
  const duration = (end - start) / minute;
  if (duration > 0 && totals.rows) {
    totals.rpm = totals.calls / duration;
    if (totals.tokens != null) totals.tpm = totals.tokens / duration;
    for (const b of minutes.values()) {
      totals.peakRPM = Math.max(totals.peakRPM ?? 0, b.calls);
      if (b.tokens != null)
        totals.peakTPM = Math.max(totals.peakTPM ?? 0, b.tokens);
    }
  }
  // Sweep once, clipping intervals on both sides. Apply simultaneous ends before starts.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0,
    last = start;
  for (const [t, delta] of edges) {
    if (t > last && active > 0) {
      const final = Math.min(47, Math.ceil((t - start) / width) - 1);
      for (let i = index(last); i <= final; i++)
        bins[i].peak = Math.max(bins[i].peak ?? 0, active);
      totals.peak = Math.max(totals.peak ?? 0, active);
    }
    last = t;
    active += delta;
  }
  for (const bin of bins) {
    bin.rpm = bin.rows ? (bin.calls * minute) / width : null;
    bin.tpm = valid(bin.tokens) ? (bin.tokens * minute) / width : null;
  }
  return {
    totals,
    bins,
    outcomes,
    origins,
    days: days.size,
    groups: [...groups.values()].sort(
      (a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || b.calls - a.calls,
    ),
  };
}
