/**
 * Pipeline Health entry (#684): mounts the component into the static `/pipeline` bootstrap. It
 * reads `/api/v1/metrics?view=inventory` for the selected project (src/web/pipeline/client.ts).
 */
import { mount } from "svelte";
import App from "./App.svelte";
import "./pipeline.css";

const target = document.getElementById("pipeline-app");
if (target) {
  const api = target.dataset.api ?? "/api/v1/metrics";
  target.replaceChildren();
  mount(App, { target, props: { api } });
}
