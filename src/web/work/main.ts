/**
 * Work preview entry (#753, doc/design/svelte-work-spike.md): mounts the component into the
 * static `/work-preview` bootstrap. It reads `/api/v1/briefing` and, for expanded rows,
 * `/api/v1/tickets/N` (src/web/work/client.ts).
 */
import { mount } from "svelte";
import App from "./App.svelte";
import "./work.css";

const target = document.getElementById("work-app");
if (target) {
  const api = target.dataset.api ?? "/api/v1/briefing";
  const ticketApi = target.dataset.ticketApi ?? "/api/v1/tickets";
  target.replaceChildren();
  mount(App, { target, props: { api, ticketApi } });
}
