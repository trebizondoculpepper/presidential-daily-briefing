/**
 * Rules page entry (#853): mounts the component into the static `/rules` bootstrap. The
 * component reads `/api/v1/rules` with the page's own query (src/web/rules/client.ts).
 */
import { mount } from "svelte";
import App from "./App.svelte";
import "./rules.css";

const target = document.getElementById("rules-app");
if (target) {
  const api = target.dataset.api ?? "/api/v1/rules";
  target.replaceChildren();
  mount(App, { target, props: { api } });
}
