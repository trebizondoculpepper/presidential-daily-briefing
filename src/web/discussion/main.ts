/**
 * Discussion page entry (#1103): mounts the component into the static `/discussion` bootstrap. It
 * reads `/api/v1/discussion` for the selected project (src/web/discussion/client.ts).
 */
import { mount } from "svelte";
import App from "./App.svelte";
import "./discussion.css";

const target = document.getElementById("discussion-app");
if (target) {
  const api = target.dataset.api ?? "/api/v1/discussion";
  target.replaceChildren();
  mount(App, { target, props: { api } });
}
