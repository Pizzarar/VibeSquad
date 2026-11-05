import { remoteShimInstalled, bindRemoteClient } from "./remoteBoot"; // first: installs the remote fetch shim before app modules load
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { daemonClient, start } from "./paseo";
import { needsRemotePairing } from "./paseoRemote";
import { RemotePair } from "./RemotePair";
import { loadUserName } from "./userName";
import { FiveLeads, SpriteSheet } from "./demo";
import "./styles.css";

// ?cast=1 shows the whole cast for art review; it needs no daemon.
// ?five-leads=1 shows the five project leads at sidebar size (no labels on the top row).
const q = new URLSearchParams(location.search);
const cast = q.has("cast");
const five = q.has("five-leads");
// Remote (relay) page not paired yet, or its password needs re-entering (R2-2): pairing screen, no daemon.
const pair = !cast && !five && needsRemotePairing();
if (!cast && !five && !pair) {
  // Remote mode (R2-1/R2-2): VS server calls go over the daemon connection via the plugin's vs.http RPC.
  if (remoteShimInstalled) bindRemoteClient(daemonClient);
  start();
  loadUserName();
}
createRoot(document.getElementById("root")!).render(pair ? <RemotePair /> : five ? <FiveLeads /> : cast ? <SpriteSheet /> : <App />);
