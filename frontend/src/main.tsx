import React from "react";
import ReactDOM from "react-dom/client";
import App from "./Planner";
import { ThemeProvider } from "./components/theme-provider";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider><App /></ThemeProvider>
  </React.StrictMode>,
);
