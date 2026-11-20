/**
 * Overview page entry (#824): mounts the component into the static `/overview` bootstrap. It reads
 * `/api/v1/metrics?view=news` for the selected project (src/web/overview/client.ts). Later Overview
 * sections compose into the same page and route.
 */
import { mount } from "svelte";
import App from "./App.svelte";
import "./overview.css";

const target = document.getElementById("overview-app");
if (target) {
  const api = target.dataset.api ?? "/api/v1/metrics";
  target.replaceChildren();
  mount(App, { target, props: { api } });
}
