/**
 * Configuration page entry (#818): mounts the component into the static `/configuration`
 * bootstrap. The component reads `/api/v1/configuration` with the page's own query
 * (src/web/configuration/client.ts).
 */
import { mount } from "svelte";
import App from "./App.svelte";
import "./configuration.css";

const target = document.getElementById("configuration-app");
if (target) {
  const api = target.dataset.api ?? "/api/v1/configuration";
  target.replaceChildren();
  mount(App, { target, props: { api } });
}
