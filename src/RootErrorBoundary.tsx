import { Component, type ReactNode } from "react";
import { diagError } from "./diagOverlay";

// Without this a render error unmounts the whole tree and the WebView shows a blank screen. The message also goes to the
// Android diagnostics overlay. Only the message and top stack frames render; nothing here touches app state.
export class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    diagError("render", `${error.message}\n${String(error.stack ?? "").split("\n").slice(0, 4).join("\n")}`, document);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" data-testid="root-error" style={{ padding: 16, font: "13px/1.4 monospace", background: "#070710", color: "#eef2ff", minHeight: "100vh" }}>
        <b>VibeSquad hit an error while drawing the screen.</b>
        <pre style={{ whiteSpace: "pre-wrap", color: "#ff7aa8" }}>{this.state.error.message}</pre>
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
