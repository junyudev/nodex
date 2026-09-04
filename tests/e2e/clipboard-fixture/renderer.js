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
  window.pasteFiles = [...event.clipboardData.files].map((file) => ({
    name: file.name,
    type: file.type,
    size: file.size,
  }));
  window.pastePayload = Object.fromEntries(
    [...event.clipboardData.types].map((type) => [type, event.clipboardData.getData(type)]),
  );
});
