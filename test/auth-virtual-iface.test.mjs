// Forge audit R22: Linux bridges / virtual NICs are not LAN candidates; physical NICs and tailscale0 handling are unchanged.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VIRTUAL_IFACE_RE, detectLanIp, detectMeshnetIp } from "../server/auth.mjs";

const nic = (address) => [{ family: "IPv4", address, internal: false }];

describe("VIRTUAL_IFACE_RE (R22)", () => {
  it("matches Linux bridges and virtual interfaces", () => {
    for (const n of ["docker0", "docker", "br-3f2a9c1d", "veth1a2b3c", "virbr0", "lxcbr0", "lxdbr0", "cni0", "flannel.1", "podman0", "podman1"]) {
      assert.ok(VIRTUAL_IFACE_RE.test(n), n);
    }
  });

  it("does not match physical NIC names", () => {
    for (const n of ["eth0", "enp3s0", "eno1", "wlan0", "wlp2s0", "Ethernet", "Wi-Fi", "bond0", "ens160"]) {
      assert.equal(VIRTUAL_IFACE_RE.test(n), false, n);
    }
  });

  it("keeps the Windows-era names virtual", () => {
    for (const n of ["vEthernet (WSL)", "NordLynx", "Tailscale", "ZeroTier One", "Loopback Pseudo-Interface 1"]) assert.ok(VIRTUAL_IFACE_RE.test(n), n);
  });

  it("detectLanIp prefers the physical NIC over docker0 / br-* / virbr0 even when those sort first", () => {
    const ifaces = { docker0: nic("192.168.5.1"), "br-abc123": nic("192.168.7.1"), virbr0: nic("192.168.122.1"), eth0: nic("192.168.1.20") };
    assert.equal(detectLanIp(ifaces, {}), "192.168.1.20");
  });

  it("tailscale0 still resolves as the meshnet address and is not lost to the new pattern", () => {
    const ifaces = { docker0: nic("172.17.0.1"), eth0: nic("192.168.1.20"), tailscale0: nic("100.101.102.103") };
    assert.equal(detectMeshnetIp(ifaces, {}), "100.101.102.103");
    assert.equal(detectLanIp(ifaces, {}), "192.168.1.20");
  });
});
