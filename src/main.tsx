import { createRoot } from "react-dom/client";
import { App } from "./App";
import { daemonClient, start } from "./paseo";
import "./perfBoot";
import { loadUserName } from "./userName";
import { FiveLeads, SpriteSheet } from "./demo";
import "./styles.css";

// ?cast=1 shows the whole cast for art review; it needs no daemon.
// ?five-leads=1 shows the five project leads at sidebar size (no labels on the top row).
const q = new URLSearchParams(location.search);
const cast = q.has("cast");
const five = q.has("five-leads");
if (!cast && !five) {
  start();
  loadUserName();
}
createRoot(document.getElementById("root")!).render(five ? <FiveLeads /> : cast ? <SpriteSheet /> : <App />);
