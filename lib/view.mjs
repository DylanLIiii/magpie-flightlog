const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const nf = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const fmt = (n) => (n == null ? "—" : nf.format(n));
const short = (n) =>
  n == null ? "—" : Math.abs(n) >= 10000 ? compact.format(n) : fmt(n);
const date = (t) =>
  t == null ? "—" : new Date(t).toISOString().slice(0, 16).replace("T", " ");
const names = { family: "模型家族", model: "具体模型", client: "Client" };
const units = { tpm: "TPM", rpm: "RPM", peak: "并发" };
function url(p, change) {
  const next = new URLSearchParams(p);
  for (const [k, v] of Object.entries(change))
    v ? next.set(k, v) : next.delete(k);
  return "?" + esc(next.toString());
}
function select(k, value, options) {
  return `<label>${names[k]}<select id="${k}" data-param="${k}"><option value="">全部</option>${options.map((o) => `<option ${o === value ? "selected" : ""} value="${esc(o)}">${esc(o)}</option>`).join("")}</select></label>`;
}
function summaryTile(name, value, caption, k, prev) {
  let delta = "上一周期不可比";
  if (prev?.[k] > 0 && value != null) {
    const change = (value / prev[k] - 1) * 100;
    delta = `较前期 ${change > 0 ? "+" : ""}${fmt(change)}%`;
  }
  return `<div class="tile"><p>${name}</p><strong title="${fmt(value)}">${short(value)}</strong><small>${caption}</small><small class="delta">${delta}</small></div>`;
}
function chart(d, key) {
  const values = d.bins.map((b) => b[key]);
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  const base = 161,
    h = 140,
    step = 14;
  const bars = values
    .map((v, i) => {
      const x = 2 + i * step,
        y = base - ((v ?? 0) * h) / max;
      return v == null
        ? `<path class="gap" d="M${x} ${base + 4}h9"/>`
        : `<rect class="${v === max ? "maximum" : "bar"}" x="${x}" y="${y - 0.5}" width="10" height="${Math.max(0.8, base - y)}" rx="1.6"><title>${date(d.bins[i].t)} UTC · ${fmt(v)} ${units[key]}</title></rect>`;
    })
    .join("");
  return `<div class="plot"><div class="scale"><span>${short(max)}</span><span>${short(max / 2)}</span><span>0</span></div><svg role="img" aria-label="${units[key]} 趋势，48 个等长分段。详细数值见分段明细" viewBox="0 0 672 173" preserveAspectRatio="none"><path class="grid" d="M0 21H672 M0 91H672 M0 161H672"/>${bars}</svg></div><div class="axis"><time>${date(d.start).slice(5)}</time><span>UTC</span><time>${date(d.now).slice(5)}</time></div>`;
}
function ranking(d, p) {
  const choices = Object.entries(names)
    .map(
      ([k, v]) =>
        `<a href="${url(p, { group: k })}#breakdown" ${d.group === k ? 'aria-current="true"' : ""}>${v}</a>`,
    )
    .join("");
  return `<section id="breakdown"><div class="sectionhead"><h2>用量分布</h2><nav class="segment" aria-label="分组方式">${choices}</nav></div><div class="scroll"><table><thead><tr><th>${names[d.group]}</th><th>请求数</th><th>Token 数</th><th>占比</th></tr></thead><tbody>${d.groups.map((g) => `<tr><th><a href="${url(p, { [d.group]: g.name })}">${esc(g.name)}</a></th><td>${fmt(g.calls)}</td><td>${fmt(g.tokens)}</td><td>${d.totals.tokens > 0 && g.tokens != null ? fmt((g.tokens / d.totals.tokens) * 100) + "%" : "—"}</td></tr>`).join("") || '<tr><td colspan="4">当前筛选没有记录</td></tr>'}</tbody></table></div></section>`;
}
export function render(d, p, nonce, css, script) {
  const t = d.totals,
    key = Object.hasOwn(units, p.get("metric")) ? p.get("metric") : "tpm";
  const live = d.live && d.now - d.live.t < 120000 ? d.live : null;
  const state =
    d.syncError ||
    (d.state.rebuilding
      ? "正在同步请求历史"
      : d.first == null
        ? "尚无历史记录"
        : "索引已同步");
  const duration = d.period === "all" ? "全部历史" : `过去 ${d.period} 天`;
  const previous = d.previous?.calls ? d.previous : null;
  const coverage = (covered, total) => `${fmt(covered)} / ${fmt(total)}`;
  const statusItems = Object.entries(d.outcomes)
    .map(([k, v]) => `<li><span>${k}</span><b>${fmt(v)}</b></li>`)
    .join("");
  const theme = p.get("theme") === "dark" ? "dark" : "light";
  return `<!doctype html><html lang="zh-CN" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Flightlog · 用量观察</title><style nonce="${nonce}">${css}</style></head><body>
  <header><div class="brand"><svg aria-hidden="true" viewBox="0 0 30 30"><path fill="currentColor" d="M3 23 14 5h5L8 23zm9 0L23 5h5L17 23z"/></svg><span>Flightlog</span></div><div class="host">Magpie <span>/</span> 用量观察</div><a class="refresh" href="${url(p, {})}">刷新数据</a></header>
  <main><div class="heading"><div><h1>用量观察</h1><p>${date(d.start)} — ${date(d.now)} <b>UTC</b></p></div><nav class="range" aria-label="统计时间范围">${["1", "7", "14", "30", "all"].map((v) => `<a ${d.period === v ? 'aria-current="true"' : ""} href="${url(p, { period: v })}">${v === "all" ? "全部" : v + " 天"}</a>`).join("")}</nav></div>
  <div class="filters">${Object.keys(names)
    .map((k) => select(k, d.filters[k], d.opts[k]))
    .join(
      "",
    )}<a href="${url(p, { family: "", model: "", client: "" })}">清除筛选</a></div>
  <div role="status" class="sync"><i></i>${esc(state)}${d.state.updated ? " · " + date(d.state.updated) + " UTC" : ""}${d.state.rebuilding ? " · 完成后自动更新" : ""}</div>
  ${!t.rows ? `<p class="notice">${d.state.rebuilding ? "正在建立本机索引。完整窗口可用后将显示指标。" : d.first == null ? "尚未收到请求历史。可检查本机网关是否运行，或在产生请求后刷新。" : "此窗口与筛选组合没有历史记录。可扩大时间范围或清除筛选。"}</p>` : ""}
  <div class="metrics">${summaryTile("Token 吞吐 · TPM", t.tpm, "分钟峰值 " + short(t.peakTPM), "tpm", previous)}${summaryTile("请求速率 · RPM", t.rpm, "分钟峰值 " + short(t.peakRPM), "rpm", previous)}${summaryTile("历史并发峰值", t.peak, "已结束网关请求重建", "peak", previous)}${summaryTile("流式输出 · TPS", t.speed, "单请求峰值 " + short(t.speedPeak), "speed", previous)}</div>
  <div class="middle"><section class="trend"><div class="sectionhead"><h2>负载趋势</h2><nav class="segment" aria-label="趋势指标">${Object.entries(
    units,
  )
    .map(
      ([k, v]) =>
        `<a ${key === k ? 'aria-current="true"' : ""} href="${url(p, { metric: k })}#trend-start">${v}</a>`,
    )
    .join(
      "",
    )}</nav></div><p id="trend-start">${duration} · ${key === "peak" ? "每段内最大重叠数" : "每段平均每分钟"} · 灰线表示无可用记录</p>${chart(d, key)}<details><summary>分段明细</summary><div class="scroll"><table><thead><tr><th>起点 UTC</th><th>TPM</th><th>RPM</th><th>并发峰值</th></tr></thead><tbody>${d.bins.map((b) => `<tr><th>${date(b.t)}</th><td>${fmt(b.tpm)}</td><td>${fmt(b.rpm)}</td><td>${fmt(b.peak)}</td></tr>`).join("")}</tbody></table></div></details></section>
  <aside><h2>请求结果</h2><p class="requestcount">${fmt(t.calls)} <small>次请求</small></p><ul>${statusItems}</ul><p class="sample">全网关快照 <b>${live ? fmt(live.value) : "—"}</b> 并发<br><small>${live ? date(live.t) + " UTC · 独立于筛选" : "当前无可用采样"}</small></p></aside></div>
  ${ranking(d, p)}<section class="coverage"><h2>数据覆盖与口径</h2><p>索引首末记录（UTC）　${date(d.first)} — ${date(d.last)}。当前筛选下有记录的 UTC 日期共 ${fmt(d.days)} 天，记录之间可能存在空档。</p><dl><div><dt>可重建并发 / 请求</dt><dd>${coverage(t.timed, t.calls)}</dd></div><div><dt>可辨 Client / 请求</dt><dd>${coverage(t.known, t.calls)}</dd></div><div><dt>回复具名模型 / 请求</dt><dd>${coverage(t.served, t.calls)}</dd></div><div><dt>流速样本 / 请求</dt><dd>${coverage(t.speedRows, t.calls)}</dd></div></dl><p>网关 ${fmt(d.origins.gateway)} · 共享网关 ${fmt(d.origins.shared)} · 会话 ${fmt(d.origins.session)} · 客户端上报 ${fmt(d.origins.reported)} · 其他 ${fmt(d.origins.unknown)}。本地拒绝 ${fmt(t.rejected)}。</p>
  <details><summary>查看计算方法与 Token 构成</summary><p>非缓存输入 ${fmt(t.input)}，输出 ${fmt(t.output)}。缓存读 ${fmt(t.cr)}、写 ${fmt(t.cw)} 单列。${coverage(t.tokenRows, t.rows)} 条账本行具备输入与输出计数，零值是账本报告值。</p><p>TPM 将输入与输出记在账本时间所在分钟（网关为请求开始时间）；RPM 计算最终请求。窗口均值使用完整所选时长，峰值取窗口内 UTC 自然分钟最大值。重试的已计费中间行只贡献 token。速率反映已记录用量，不能证明空档期间零使用。</p><p>并发按有耗时的网关请求区间 [开始, 开始＋耗时) 重建。TPS 沿用 Magpie 的 DecodeOf 规则，以有效输出总数除以相应解码总秒数。具备首文本时间时扣除推理 token，过滤突发回包与不可靠的短窗口。峰值取最快有效样本。Client 取账本客户端产品名；模型优先使用回复名，其次为路由名；家族按名称识别。</p><p>对比取紧邻的前一等长窗口。索引起点过晚、前期无请求或基数为零时显示不可比。全部历史从首条记录起算。</p></details></section></main><script nonce="${nonce}">${script}</script></body></html>`;
}
