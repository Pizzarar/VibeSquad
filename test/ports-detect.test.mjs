import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clearWorkspacePorts,
  detectPortsInText,
  dismissWorkspacePort,
  getWorkspacePorts,
  recordWorkspacePorts,
  stripAnsi,
  subscribeWorkspacePorts,
} from "../src/portsDetect.ts";

const readSrc = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");

test("stripAnsi removes colour, bold, cursor, and OSC escape sequences", () => {
  const viteLine = "\x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m";
  assert.equal(stripAnsi(viteLine), "➜  Local:   http://localhost:5173/");
  assert.equal(stripAnsi("\x1b]0;vite dev\x07\x1b[2K\x1b[1Gready"), "ready");
});

test("detectPortsInText detects Vite, Next.js (0.0.0.0 normalized), Express, IPv6 [::1], and HTTPS URLs", () => {
  const now = 1700000000000;
  const output = [
    "\x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m",
    "started server on 0.0.0.0:3000, url: http://0.0.0.0:3000",
    "Express app Listening on port 8080",
    "IPv6 server bound at http://[::1]:4000/",
    "Secure dev server: https://localhost:8443/app",
    "Listening on :9090",
  ].join("\n");

  const detected = detectPortsInText(output, now);
  const byPort = new Map(detected.map((d) => [d.port, d]));

  assert.equal(byPort.get(5173)?.url, "http://localhost:5173");
  assert.equal(byPort.get(5173)?.protocol, "http");
  assert.equal(byPort.get(5173)?.label, "Local");
  assert.equal(byPort.get(5173)?.lastSeenAt, now);

  assert.equal(byPort.get(3000)?.url, "http://localhost:3000");
  assert.equal(byPort.get(3000)?.host, "0.0.0.0");

  assert.equal(byPort.get(8080)?.url, "http://localhost:8080");
  assert.equal(byPort.get(8080)?.host, "localhost");

  assert.equal(byPort.get(4000)?.url, "http://localhost:4000");
  assert.equal(byPort.get(4000)?.host, "[::1]");

  assert.equal(byPort.get(8443)?.url, "https://localhost:8443/app");
  assert.equal(byPort.get(8443)?.protocol, "https");

  assert.equal(byPort.get(9090)?.url, "http://localhost:9090");
});

test("detectPortsInText ignores EADDRINUSE / already in use errors and out-of-range ports", () => {
  const errOutput = [
    "Error: listen EADDRINUSE: address already in use 0.0.0.0:3000",
    "Error: listen EADDRINUSE: address already in use :::8080",
    "Port 4321 is already in use",
    "port 4321 is in use, trying another one...",
    "Listening on port 0",
    "http://localhost:0/",
    "http://localhost:70000/",
    "Listening on port 99999",
  ].join("\n");

  assert.deepEqual(detectPortsInText(errOutput), []);

  // If a line mentions an in-use port AND prints an explicit bound fallback URL, only the bound URL is returned
  const fallback = detectPortsInText("Port 3000 is already in use, running at http://127.0.0.1:3001/dashboard", 123);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].port, 3001);
  assert.equal(fallback[0].url, "http://127.0.0.1:3001/dashboard");
});

test("store helpers record, deduplicate, dismiss, subscribe, and clear per workspace", () => {
  clearWorkspacePorts();
  let notifications = 0;
  const unsub = subscribeWorkspacePorts(() => {
    notifications++;
  });

  const wsA = "/workspace/app-a";
  const wsB = "/workspace/app-b";

  recordWorkspacePorts(wsA, "Listening on port 3000", 100);
  recordWorkspacePorts(wsA, "Local: http://localhost:3000/admin", 200);
  recordWorkspacePorts(wsB, "Local: http://localhost:5173/", 150);

  const portsA = getWorkspacePorts(wsA);
  assert.equal(portsA.length, 1);
  assert.equal(portsA[0].port, 3000);
  assert.equal(portsA[0].url, "http://localhost:3000/admin");
  assert.equal(portsA[0].label, "Local");
  assert.equal(portsA[0].lastSeenAt, 200);

  assert.equal(getWorkspacePorts(wsB).length, 1);
  assert.equal(getWorkspacePorts(wsB)[0].port, 5173);
  assert.ok(notifications >= 3);

  dismissWorkspacePort(wsA, 3000);
  assert.deepEqual(getWorkspacePorts(wsA), []);
  assert.equal(getWorkspacePorts(wsB).length, 1);

  clearWorkspacePorts(wsB);
  assert.deepEqual(getWorkspacePorts(wsB), []);

  unsub();
});

test("wiring: TerminalPanel and SandboxView render listening port pills with required testids", () => {
  const termSrc = readSrc("TerminalPanel.tsx");
  assert.match(termSrc, /detectPortsInText/);
  assert.match(termSrc, /recordWorkspacePorts/);
  assert.match(termSrc, /data-testid="terminal-ports-bar"/);
  assert.match(termSrc, /data-testid=\{`port-pill-\$\{p\.port\}`\}/);
  assert.match(termSrc, /target="_blank"/);
  assert.match(termSrc, /rel="noopener noreferrer"/);

  const sandboxSrc = readSrc("SandboxView.tsx");
  assert.match(sandboxSrc, /subscribeWorkspacePorts/);
  assert.match(sandboxSrc, /getWorkspacePorts/);
  assert.match(sandboxSrc, /detectedPorts\?: DetectedPort\[\]/);
  assert.match(sandboxSrc, /data-testid="sandbox-listening-ports"/);
  assert.match(sandboxSrc, /None detected in terminal/);
  assert.match(sandboxSrc, /target="_blank"/);
  assert.match(sandboxSrc, /rel="noopener noreferrer"/);
});
