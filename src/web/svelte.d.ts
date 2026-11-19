/** Svelte components, compiled at build time by @sveltejs/vite-plugin-svelte (#853). */
declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component<any>;
  export default component;
}

/** Stylesheets imported by entries are emitted as separate same-origin files (no inline CSS). */
declare module "*.css";
