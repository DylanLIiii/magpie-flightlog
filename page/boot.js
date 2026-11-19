(async () => {
  const theme = await magpie.ready;
  const options = await magpie.options.get();
  const port = Number(options?.port ?? 3467);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("插件端口无效");
  const url = new URL(magpie.service || `http://127.0.0.1:${port}/`);
  url.searchParams.set("theme", theme.dark ? "dark" : "light");
  location.replace(url.href);
})().catch(
  () =>
    (document.querySelector("p").textContent =
      "无法连接页面服务。请检查 Magpie 的插件状态和端口，然后重新打开此页。"),
);
