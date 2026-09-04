window.copyPayload = {};
window.pastePayload = null;
document.addEventListener("copy", (event) => {
  event.preventDefault();
  for (const [type, value] of Object.entries(window.copyPayload)) {
    event.clipboardData.setData(type, value);
  }
});
document.addEventListener("paste", (event) => {
  event.preventDefault();
  window.pastePayload = Object.fromEntries(
    [...event.clipboardData.types].map((type) => [type, event.clipboardData.getData(type)]),
  );
});
