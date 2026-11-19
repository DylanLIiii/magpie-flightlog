document.querySelectorAll("select[data-param]").forEach((select) => {
  select.addEventListener("change", () => {
    const url = new URL(location.href);
    const key = select.dataset.param;
    if (select.value) url.searchParams.set(key, select.value);
    else url.searchParams.delete(key);
    if (key === "family") url.searchParams.delete("model");
    url.hash = key;
    location.assign(url);
  });
});
if (location.hash)
  document
    .getElementById(location.hash.slice(1))
    ?.focus({ preventScroll: true });
if (document.querySelector(".sync").textContent.includes("完成后自动更新")) {
  setTimeout(() => {
    if (!document.hidden) location.reload();
  }, 5000);
}
