export function DrawerSlot({ id }: { id: string }) {
  return (
    <div style={{ padding: 14, color: "var(--text)", font: "13px/1.5 var(--mono, monospace)", height: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 8 }}>
      <div><b>you</b> ship the slam</div>
      <div style={{ color: "var(--muted)" }}><b style={{ color: "var(--text)" }}>{id}</b> on it. window opens, window lands.</div>
      <div style={{ marginTop: "auto", height: 56, border: "1px solid var(--line)", background: "var(--panel)" }} />
    </div>
  );
}
