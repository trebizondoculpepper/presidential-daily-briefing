/**
 * Timing page entry (#820): mounts the component into the static `/timing` bootstrap. It reads
 * `/api/v1/metrics?view=timing` for the selected project (src/web/timing/client.ts).
 */
import { mount } from "svelte";
import App from "./App.svelte";
import "./timing.css";

const target = document.getElementById("timing-app");
if (target) {
  const api = target.dataset.api ?? "/api/v1/metrics";
  target.replaceChildren();
  mount(App, { target, props: { api } });
}
