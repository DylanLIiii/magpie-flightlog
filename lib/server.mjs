import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Ledger } from "./ledger.mjs";
import { collector, gatewayURL } from "./collector.mjs";
import { metrics } from "./metrics.mjs";
import { render } from "./view.mjs";
const css = readFileSync(new URL("../ui/theme.css", import.meta.url), "utf8");
const script = readFileSync(
  new URL("../ui/actions.js", import.meta.url),
  "utf8",
);
export async function startServer({ port = 3467, dir = "", addr, file } = {}) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw Error("无效端口");
  const base = gatewayURL(addr);
  const profile = createHash("sha256")
    .update(
      resolve(
        dir || process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      ) +
        "\n" +
        base,
    )
    .digest("hex")
    .slice(0, 16);
  let ledger, source;
  function open() {
    if (source) return;
    const stateDir =
      process.env.FLIGHTLOG_STATE ||
      join(
        process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
        "magpie-flightlog",
      );
    ledger = new Ledger(file ?? join(stateDir, profile + ".sqlite"));
    source = collector(ledger, base);
    source.start();
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (
        req.headers.get("host") !== `127.0.0.1:${server.port}` &&
        req.headers.get("host") !== `localhost:${server.port}`
      )
        return new Response(null, { status: 403 });
      if (req.method !== "GET") return new Response(null, { status: 405 });
      if (!["/", "/api/metrics"].includes(url.pathname))
        return new Response(null, { status: 404 });
      const origin = req.headers.get("origin");
      if (origin && origin !== "null" && origin !== url.origin)
        return new Response(null, { status: 403 });
      const nonce = randomBytes(18).toString("base64");
      const headers = {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; form-action 'none'`,
      };
      try {
        open();
        const data = metrics(ledger.db, url.searchParams);
        data.syncError = source.info.error;
        data.live = source.info.live;
        if (url.pathname === "/api/metrics")
          return Response.json(data, { headers });
        return new Response(
          render(data, url.searchParams, nonce, css, script),
          {
            headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
          },
        );
      } catch {
        return new Response("无法读取指标索引，请检查数据目录权限后重试。", {
          status: 503,
          headers,
        });
      }
    },
  });
  return {
    port: server.port,
    async stop() {
      server.stop(true);
      await source?.stop();
      ledger?.db.close();
    },
  };
}
