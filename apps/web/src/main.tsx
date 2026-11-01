import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/m-plus-1-code/400.css";
import "@fontsource/m-plus-1-code/700.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

document.documentElement.setAttribute("data-theme", localStorage.getItem("stockai.theme") ?? "ink");
document.documentElement.setAttribute("data-updown", localStorage.getItem("stockai.updown") ?? "jp");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
