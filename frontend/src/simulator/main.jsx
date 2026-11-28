import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import "./simulator.css";
import Simulator from "./Simulator.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Simulator />
  </StrictMode>,
);
