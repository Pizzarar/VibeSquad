import { createRoot } from "react-dom/client";
import { App } from "./App";
import { start } from "./paseo";
import { startComposerQueueFlusher } from "./composerQueueWire";
import "./perfBoot";
import { loadUserName } from "./userName";
import { isRemote } from "./remoteSession";
import { RemotePairScreen } from "./RemotePairScreen";
import { FiveLeads, SpriteSheet } from "./demo";
import "./styles.css";

// ?cast=1 shows the whole cast for art review; it needs no daemon.
// ?five-leads=1 shows the five project leads at sidebar size (no labels on the top row).
const q = new URLSearchParams(location.search);
const cast = q.has("cast");
const five = q.has("five-leads");
// The APK (remote build) carries no UI of its own beyond pairing: it pairs with the PC over LAN/Meshnet, then
// opens the server's UI (RemotePairScreen), so it never starts the local client.
const remote = isRemote();
if (!cast && !five && !remote) {
  start();
  startComposerQueueFlusher();
  loadUserName();
}
createRoot(document.getElementById("root")!).render(remote ? <RemotePairScreen /> : five ? <FiveLeads /> : cast ? <SpriteSheet /> : <App />);
