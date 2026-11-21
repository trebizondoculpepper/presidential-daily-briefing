import { mount } from "svelte";
import Counter from "./Counter.svelte";

const target = document.getElementById("app");
if (target) mount(Counter, { target });
