import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  applyDaemonClientPassword,
  clearDaemonPassword,
  fetchDaemonAuthStatus,
  fetchLocalDaemonPassword,
  readClientAuthFailure,
  submitDaemonPassword,
} from "../src/paseoDaemonAuth.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("P0-B · paseoDaemonAuth helpers", () => {
  test("applyDaemonClientPassword sets config.password, re-enables reconnect.enabled, and removes password when cleared", () => {
    const dc = {
      config: {
        url: "ws://127.0.0.1:6767/ws",
        clientId: "vibesquad",
        reconnect: { enabled: false, baseDelayMs: 1000, maxDelayMs: 10000 },
      },
    };

    applyDaemonClientPassword(dc, "  secret-pw-123  ");
    assert.equal(dc.config.password, "secret-pw-123");
    assert.equal(dc.config.reconnect.enabled, true);
    assert.equal(dc.config.reconnect.baseDelayMs, 1000);

    // Clearing password removes config.password while keeping reconnect enabled
    dc.config.reconnect.enabled = false;
    applyDaemonClientPassword(dc, "");
    assert.equal("password" in dc.config, false);
    assert.equal(dc.config.reconnect.enabled, true);

    // Null/invalid client inputs are safe no-ops
    applyDaemonClientPassword(null, "pw");
    applyDaemonClientPassword({}, "pw");
  });

  test("readClientAuthFailure detects password_required and incorrect_password across client details, error.reason, and messages", () => {
    assert.equal(
      readClientAuthFailure({ getConnectionDetails: () => ({ authFailureReason: "password_required" }) }),
      "password_required",
    );
    assert.equal(
      readClientAuthFailure({ getConnectionDetails: () => ({ authFailureReason: "incorrect_password" }) }),
      "incorrect_password",
    );
    assert.equal(
      readClientAuthFailure({ authFailureReason: "password_required" }),
      "password_required",
    );
    assert.equal(
      readClientAuthFailure({}, Object.assign(new Error("Auth failed"), { reason: "incorrect_password" })),
      "incorrect_password",
    );
    assert.equal(
      readClientAuthFailure({}, new Error("Handshake rejected: password_required")),
      "password_required",
    );
    assert.equal(
      readClientAuthFailure({}, new Error("Daemon says: Password Required")),
      "password_required",
    );
    assert.equal(
      readClientAuthFailure({}, new Error("Handshake rejected: incorrect password")),
      "incorrect_password",
    );
    assert.equal(
      readClientAuthFailure({ getConnectionDetails: () => ({ authFailureReason: null }) }, new Error("WebSocket connection refused")),
      null,
    );
    assert.equal(readClientAuthFailure(null, null), null);
  });

  test("fetchLocalDaemonPassword, fetchDaemonAuthStatus, submitDaemonPassword, and clearDaemonPassword work with mocked fetch", async () => {
    const calls = [];
    const mockFetch = async (url, init) => {
      calls.push({ url, init });
      if (url === "/__vibesquad/paseo/daemon-auth?includePassword=1") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            required: true,
            configured: true,
            source: "file",
            password: "local-secret-pw",
          }),
        };
      }
      if (url === "/__vibesquad/paseo/daemon-auth" && (!init || !init.method || init.method === "GET")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            required: true,
            configured: false,
            source: "none",
          }),
        };
      }
      if (url === "/__vibesquad/paseo/daemon-auth" && init?.method === "POST") {
        const body = JSON.parse(init.body);
        if (body.clear) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              required: true,
              configured: false,
              source: "none",
              cleared: true,
            }),
          };
        }
        if (body.password === "good-pw") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              required: true,
              configured: true,
              source: "file",
              verified: true,
            }),
          };
        }
        return {
          ok: false,
          status: 401,
          json: async () => ({
            ok: false,
            required: true,
            configured: false,
            source: "none",
            error: "Invalid daemon password",
            authFailureReason: "incorrect_password",
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const localPw = await fetchLocalDaemonPassword(mockFetch);
    assert.deepEqual(localPw, {
      required: true,
      configured: true,
      source: "file",
      password: "local-secret-pw",
    });

    const status = await fetchDaemonAuthStatus(mockFetch);
    assert.equal(status.ok, true);
    assert.equal(status.required, true);
    assert.equal(status.configured, false);
    assert.equal(status.source, "none");

    const badSubmit = await submitDaemonPassword("wrong-pw", mockFetch);
    assert.equal(badSubmit.status, 401);
    assert.equal(badSubmit.ok, false);
    assert.equal(badSubmit.authFailureReason, "incorrect_password");
    assert.match(badSubmit.error, /Invalid daemon password/);

    const goodSubmit = await submitDaemonPassword("good-pw", mockFetch);
    assert.equal(goodSubmit.status, 200);
    assert.equal(goodSubmit.ok, true);
    assert.equal(goodSubmit.configured, true);
    assert.equal(goodSubmit.source, "file");

    const cleared = await clearDaemonPassword(mockFetch);
    assert.equal(cleared.status, 200);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.configured, false);

    // Fallback when fetch throws
    const fallback = await fetchLocalDaemonPassword(async () => {
      throw new Error("network down");
    });
    assert.deepEqual(fallback, {
      required: false,
      configured: false,
      source: "none",
      password: null,
    });
  });

  test("source guards: z-index lift, DaemonStatusBanner unlock + escape hatches, FirstRunModal daemon + password controls", () => {
    const css = read("src/ResponsiveSmallWindow.css");
    assert.match(
      css,
      /\.modal-back:has\(\[data-testid="diagnostics-modal"\],\s*\[data-testid="first-run-checklist-modal"\],\s*\.settings-home\)\s*\{\s*z-index:\s*9600;\s*\}/,
    );

    const diag = read("src/DiagnosticsModal.tsx");
    for (const id of [
      "daemon-banner-auth-form",
      "daemon-banner-password-input",
      "daemon-banner-unlock-btn",
      "daemon-banner-auth-error",
      "daemon-banner-retry",
      "daemon-banner-diagnostics",
      "daemon-banner-setup",
      "daemon-banner-paseo-settings",
    ]) {
      assert.ok(diag.includes(id), `DiagnosticsModal.tsx missing ${id}`);
    }

    const firstRun = read("src/FirstRunModal.tsx");
    for (const id of [
      "first-run-daemon-start-btn",
      "first-run-password-input",
      "first-run-password-save-btn",
    ]) {
      assert.ok(firstRun.includes(id), `FirstRunModal.tsx missing ${id}`);
    }

    const paseo = read("src/paseo.ts");
    assert.match(paseo, /export async function reconnectWithDaemonPassword/);
    assert.match(paseo, /fetchLocalDaemonPassword/);
    assert.match(paseo, /readClientAuthFailure/);

    const app = read("src/App.tsx");
    assert.match(app, /onOpenSetup=\{\(\) => setFirstRunOpen\(true\)\}/);
    assert.match(app, /requestSettingsTarget\("paseo-daemon"\)/);
  });
});
