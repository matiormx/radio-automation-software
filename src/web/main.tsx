import { installMenuFit } from "../ctxfit";
import React from "react";
import ReactDOM from "react-dom/client";
import { WebApp } from "./WebApp";
import "../styles.css";
import "./web.css";


installMenuFit();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WebApp />
  </React.StrictMode>,
);
