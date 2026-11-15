// Progressive enhancement: all commands remain selectable when JS is unavailable.
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  button.hidden = false;
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copy ?? "");
    const status = document.getElementById("copy-status");
    if (!target || !status) return;
    try {
      await navigator.clipboard.writeText(target.textContent ?? "");
      status.textContent = "Command copied.";
      button.textContent = "Copied";
    } catch {
      status.textContent = "Copy unavailable. Select the command text to copy it.";
      button.textContent = "Select text to copy";
    }
  });
}
