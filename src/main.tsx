import { createRoot } from "react-dom/client";
import { App } from "./App";
import { daemonClient, start } from "./paseo";
import { installRemoteTransport, isRemoteMode } from "./remoteTransport";
import { loadUserName } from "./userName";
import { FiveLeads, SpriteSheet } from "./demo";
import "./styles.css";

// ?cast=1 shows the whole cast for art review; it needs no daemon.
// ?five-leads=1 shows the five project leads at sidebar size (no labels on the top row).
const q = new URLSearchParams(location.search);
const cast = q.has("cast");
const five = q.has("five-leads");
if (!cast && !five) {
  // Remote mode (R2-1): VS server calls go over the daemon connection via the plugin's vs.http RPC.
  if (isRemoteMode()) installRemoteTransport((input) => daemonClient.invokePluginRpc("vibesquad", "vs.http", input));
  start();
  loadUserName();
}
createRoot(document.getElementById("root")!).render(five ? <FiveLeads /> : cast ? <SpriteSheet /> : <App />);
