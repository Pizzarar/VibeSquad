// Test hermeticity (idea-248): import this FIRST in a test that runs a real RunnerClient/runner in-process. It drops the
// agent/session identity a shell inside an agent exports (VS_*, VIBESQUAD_*, PASEO_*), which would turn the client into a
// verified agent caller ("agent token invalid"). Tests then set the VIBESQUAD_* vars they need themselves, after this import.
for (const k of Object.keys(process.env)) {
  if (/^(VS_|VIBESQUAD_|PASEO_)/i.test(k)) delete process.env[k];
}
