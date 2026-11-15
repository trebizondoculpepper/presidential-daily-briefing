// website/copy.ts
for (let e of document.querySelectorAll("button[data-copy]")) e.hidden = !1, e.addEventListener("click", async () => {
	let t = document.getElementById(e.dataset.copy ?? ""), n = document.getElementById("copy-status");
	if (t && n) try {
		await navigator.clipboard.writeText(t.textContent ?? ""), n.textContent = "Command copied.", e.textContent = "Copied";
	} catch {
		n.textContent = "Copy unavailable. Select the command text to copy it.", e.textContent = "Select text to copy";
	}
});
