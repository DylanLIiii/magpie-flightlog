export function gatewayURL(addr = process.env.MAGPIE_ADDR || "127.0.0.1:3425") {
  const url = new URL("http://" + addr);
  if (["0.0.0.0", "[::]"].includes(url.hostname)) url.hostname = "127.0.0.1";
  if (
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error("网关地址须为本机回环地址");
  return url.origin;
}
export function collector(ledger, base, request = fetch) {
  let stopped = false,
    running = null,
    timer = null;
  const info = { error: "", live: null };
  async function poll() {
    let again = true,
      reset = false;
    while (again && !stopped) {
      const { cursor } = ledger.state();
      const url = new URL("/v1/magpie/usage/requests", base);
      url.search = new URLSearchParams({ cursor, limit: "500" });
      const res = await request(url, {
        redirect: "error",
        signal: AbortSignal.timeout(45000),
      });
      if (!reset && cursor !== "start" && [400, 410].includes(res.status)) {
        const data = await res.json();
        if (
          [
            "cursor_invalid",
            "cursor_filter_changed",
            "cursor_reset",
            "cursor_expired",
          ].includes(data.error?.code ?? data.code)
        ) {
          ledger.reset(cursor);
          reset = true;
          continue;
        }
      }
      if (!res.ok) throw Error("网关返回 HTTP " + res.status);
      const page = await res.json();
      ledger.apply(cursor, page);
      again = page.has_more;
    }
    info.error = "";
  }
  async function sample() {
    try {
      const res = await request(base + "/v1/magpie/concurrency", {
        redirect: "error",
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw Error();
      const { requests } = await res.json();
      info.live =
        Number.isSafeInteger(requests) && requests >= 0
          ? { value: requests, t: Date.now() }
          : null;
    } catch {
      info.live = null;
    }
  }
  function sync() {
    if (!running)
      running = Promise.all([
        sample(),
        poll().catch((e) => {
          info.error =
            /^(网关返回 HTTP \d+|feed 格式不兼容|feed 行标识异常)$/.test(
              e.message,
            )
              ? e.message
              : "暂时无法同步本机请求记录";
        }),
      ]).finally(() => {
        running = null;
      });
    return running;
  }
  return {
    info,
    sync,
    start() {
      void sync();
      timer = setInterval(sync, 60000);
      timer.unref();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
