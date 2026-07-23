import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import App from "./App.svelte";
import { mount } from "svelte";

mount(App, { target: document.getElementById("app")! });
