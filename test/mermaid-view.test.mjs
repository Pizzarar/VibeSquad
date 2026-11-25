import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const raw = readFileSync(fileURLToPath(url), "utf8");
      const cut = raw.indexOf("// ─── React Component");
      const source = cut !== -1 ? raw.slice(0, cut) : raw;
      return { format: "module-typescript", shortCircuit: true, source };
    }
    return nextLoad(url, context);
  },
});

const {
  detectMermaidKind,
  escapeXml,
  parseMermaid,
  renderMermaidSvg,
  sanitizeSvg,
} = await import("../src/MermaidView.tsx");

const readRepoFile = (relPath) =>
  readFileSync(new URL(`../${relPath}`, import.meta.url), "utf8");

describe("V1 MermaidView — detectMermaidKind", () => {
  test("detects flowchart and graph directions", () => {
    assert.equal(detectMermaidKind("flowchart TD\n  A --> B"), "flowchart");
    assert.equal(detectMermaidKind("flowchart TB\n  A --> B"), "flowchart");
    assert.equal(detectMermaidKind("flowchart BT\n  A --> B"), "flowchart");
    assert.equal(detectMermaidKind("flowchart RL\n  A --> B"), "flowchart");
    assert.equal(detectMermaidKind("flowchart LR\n  A --> B"), "flowchart");
    assert.equal(detectMermaidKind("graph LR\n  A --> B"), "flowchart");
    assert.equal(detectMermaidKind("graph TD; A-->B;"), "flowchart");
  });

  test("detects sequenceDiagram and stateDiagram / stateDiagram-v2", () => {
    assert.equal(detectMermaidKind("sequenceDiagram\n  Alice->>Bob: Hello"), "sequence");
    assert.equal(detectMermaidKind("stateDiagram\n  [*] --> Still"), "state");
    assert.equal(detectMermaidKind("stateDiagram-v2\n  [*] --> Still"), "state");
  });

  test("skips leading %% comments and YAML frontmatter", () => {
    assert.equal(
      detectMermaidKind("%%{init: {'theme': 'dark'}}%%\nflowchart LR\n  A --> B"),
      "flowchart",
    );
    assert.equal(
      detectMermaidKind("---\ntitle: Demo\n---\nsequenceDiagram\n  A->>B: Ping"),
      "sequence",
    );
  });

  test("returns unknown on empty or unsupported syntax", () => {
    assert.equal(detectMermaidKind(""), "unknown");
    assert.equal(detectMermaidKind("   \n  "), "unknown");
    assert.equal(detectMermaidKind("pie title Pets\n  \"Dogs\" : 42"), "unknown");
    assert.equal(detectMermaidKind("gantt\n  title A Gantt"), "unknown");
  });
});

describe("V1 MermaidView — flowchart & graph rendering", () => {
  test("renders flowchart TD and graph LR with valid SVG, viewBox, and counts", () => {
    const td = renderMermaidSvg("flowchart TD\n  A[Start] --> B[End]");
    assert.equal(td.ok, true);
    assert.equal(td.kind, "flowchart");
    assert.equal(td.nodeCount, 2);
    assert.equal(td.edgeCount, 1);
    assert.match(td.svg, /^<svg\b[^>]*viewBox="0 0 \d+ \d+"/);
    assert.match(td.svg, /Start/);
    assert.match(td.svg, /End/);
    assert.match(td.svg, /<marker id="mermaid-arrow"/);

    const lr = renderMermaidSvg("graph LR\n  X(Input) --> Y(Transform) --> Z(Output)");
    assert.equal(lr.ok, true);
    assert.equal(lr.kind, "flowchart");
    assert.equal(lr.nodeCount, 3);
    assert.equal(lr.edgeCount, 2);
    assert.match(lr.svg, /Input/);
    assert.match(lr.svg, /Transform/);
    assert.match(lr.svg, /Output/);
  });

  test("supports node shapes: [rect], (round), ([stadium]), {diamond}, ((circle)), and bare", () => {
    const code = [
      "flowchart TD",
      "  R[RectNode] --> Rd(RoundNode)",
      "  Rd --> St([StadiumNode])",
      "  St --> Dm{DiamondNode}",
      "  Dm --> Cr((CircleNode))",
      "  Cr --> BareNode",
    ].join("\n");

    const parsed = parseMermaid(code);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.nodeCount, 6);
    assert.equal(parsed.edgeCount, 5);

    const shapeById = Object.fromEntries(parsed.nodes.map((n) => [n.id, n.shape]));
    assert.equal(shapeById.R, "rect");
    assert.equal(shapeById.Rd, "round");
    assert.equal(shapeById.St, "stadium");
    assert.equal(shapeById.Dm, "diamond");
    assert.equal(shapeById.Cr, "circle");
    assert.equal(shapeById.BareNode, "rect");

    const res = renderMermaidSvg(code);
    assert.equal(res.ok, true);
    assert.match(res.svg, /data-shape="rect"/);
    assert.match(res.svg, /data-shape="round"/);
    assert.match(res.svg, /data-shape="stadium"/);
    assert.match(res.svg, /data-shape="diamond"/);
    assert.match(res.svg, /data-shape="circle"/);
    assert.match(res.svg, /<polygon\b/);
    assert.match(res.svg, /<circle\b/);
  });

  test("supports edge labels (-->|yes|, -- no -->) and edge styles (---, -.->, ==>)", () => {
    const code = [
      "flowchart LR",
      "  A{Check} -->|yes| B[Approve]",
      "  A -- no --> C[Reject]",
      "  B -.->|audit| D((Log))",
      "  C ==> E[Archive]",
      "  D --- E",
    ].join("\n");

    const res = renderMermaidSvg(code);
    assert.equal(res.ok, true);
    assert.equal(res.nodeCount, 5);
    assert.equal(res.edgeCount, 5);
    assert.match(res.svg, />yes<\/text>/);
    assert.match(res.svg, />no<\/text>/);
    assert.match(res.svg, />audit<\/text>/);
    assert.match(res.svg, /stroke-dasharray="5,4"/);
    assert.match(res.svg, /stroke-width="2\.6"/);
  });

  test("supports subgraph ... end blocks", () => {
    const code = [
      "flowchart TD",
      "  subgraph Backend [API Layer]",
      "    A[Gateway] --> B[Service]",
      "  end",
      "  B --> C[(Database)]",
    ].join("\n");

    const res = renderMermaidSvg(code);
    assert.equal(res.ok, true);
    assert.equal(res.nodeCount, 3);
    assert.equal(res.edgeCount, 2);
    assert.match(res.svg, /class="mermaid-subgraph"/);
    assert.match(res.svg, /API Layer/);
  });
});

describe("V1 MermaidView — sequenceDiagram rendering", () => {
  test("parses participant/actor declarations and all message arrows (->>, -->>, ->, -->, -x, --x)", () => {
    const code = [
      "sequenceDiagram",
      "  participant C as Client",
      "  actor U as User",
      "  U->>C: Click Login",
      "  C-->>U: Show Spinner",
      "  C->Auth: Verify Token",
      "  Auth-->C: Token Valid",
      "  C-xAudit: Failed Hook",
      "  Audit--xC: Retry Later",
    ].join("\n");

    const res = renderMermaidSvg(code);
    assert.equal(res.ok, true);
    assert.equal(res.kind, "sequence");
    assert.equal(res.nodeCount, 4); // C, U, Auth, Audit
    assert.equal(res.edgeCount, 6);
    assert.match(res.svg, /class="mermaid-participant"/);
    assert.match(res.svg, /class="mermaid-lifeline"/);
    assert.match(res.svg, /Click Login/);
    assert.match(res.svg, /Show Spinner/);
    assert.match(res.svg, /Verify Token/);
    assert.match(res.svg, /Token Valid/);
    assert.match(res.svg, /Failed Hook/);
    assert.match(res.svg, /Retry Later/);
    assert.match(res.svg, /mermaid-arrow-cross/);
    assert.match(res.svg, /mermaid-arrow-open/);
  });
});

describe("V1 MermaidView — stateDiagram / stateDiagram-v2 rendering", () => {
  test("parses [*] start/end states, transitions with labels, and State : description", () => {
    const code = [
      "stateDiagram-v2",
      "  [*] --> Idle",
      "  Idle : Waiting for job",
      "  Idle --> Running : dispatch",
      "  Running --> [*] : complete",
    ].join("\n");

    const res = renderMermaidSvg(code);
    assert.equal(res.ok, true);
    assert.equal(res.kind, "state");
    assert.equal(res.nodeCount, 4); // __start__, Idle, Running, __end__
    assert.equal(res.edgeCount, 3);
    assert.match(res.svg, /data-shape="state-start"/);
    assert.match(res.svg, /data-shape="state-end"/);
    assert.match(res.svg, /Idle: Waiting for job/);
    assert.match(res.svg, />dispatch<\/text>/);
    assert.match(res.svg, />complete<\/text>/);
  });
});

describe("V1 MermaidView — XSS / XML-escaping & security", () => {
  test("strictly escapes <, >, &, \", ' in node labels, edge labels, and participants", () => {
    const code = [
      "flowchart TD",
      '  A["<script>alert(1)</script>"] -->|"<img onerror=alert(1)> & \'quote\'"| B["a & b"]',
    ].join("\n");

    const res = renderMermaidSvg(code);
    assert.equal(res.ok, true);
    assert.equal(res.nodeCount, 2);
    assert.equal(res.edgeCount, 1);

    // Must not contain raw <script> or <img tags
    assert.doesNotMatch(res.svg, /<script/i);
    assert.doesNotMatch(res.svg, /<img/i);
    assert.doesNotMatch(res.svg, /onerror\s*=/i);

    // Must contain XML-escaped text
    assert.match(res.svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(res.svg, /a &amp; b/);
    assert.match(res.svg, /&amp; &apos;quote&apos;/);
  });

  test("escapeXml and sanitizeSvg strip dangerous constructs", () => {
    assert.equal(
      escapeXml(`<tag attr="1" single='2'>a & b</tag>`),
      "&lt;tag attr=&quot;1&quot; single=&apos;2&apos;&gt;a &amp; b&lt;/tag&gt;",
    );
    const dirty = `<svg onclick="evil()"><script>alert(1)</script><foreignObject>bad</foreignObject><rect width="10" height="10" onload="bad()" /></svg>`;
    const clean = sanitizeSvg(dirty);
    assert.doesNotMatch(clean, /<script/i);
    assert.doesNotMatch(clean, /<foreignObject/i);
    assert.doesNotMatch(clean, /onclick/i);
    assert.doesNotMatch(clean, /onload/i);
  });
});

describe("V1 MermaidView — graceful fallback on invalid or unknown syntax", () => {
  test("never throws and returns { ok: false, error } on empty, unknown, or nodeless input", () => {
    for (const bad of [
      "",
      "   ",
      "pie\n  \"A\": 10",
      "flowchart TD",
      "sequenceDiagram",
      "stateDiagram-v2",
      "not a mermaid diagram at all",
    ]) {
      const res = renderMermaidSvg(bad);
      assert.equal(res.ok, false, `expected ok=false for ${JSON.stringify(bad)}`);
      assert.equal(typeof res.error, "string");
      assert.ok(res.error.length > 0);
    }
  });
});

describe("V1 MermaidView — component & Timeline / BriefEditor wiring", () => {
  test("MermaidView.tsx has MERMAID badge, Diagram/Source toggle, Copy button, and required testids", () => {
    const src = readRepoFile("src/MermaidView.tsx");
    assert.match(src, /MERMAID/);
    assert.match(src, /data-testid="mermaid-diagram"/);
    assert.match(src, /data-testid="mermaid-source"/);
    assert.match(src, /<pre className="tl-code"><code>\{code\}<\/code><\/pre>/);
    assert.match(src, /Copied/);
    assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
  });

  test("Timeline.tsx renders <MermaidView> for ```mermaid code blocks", () => {
    const tl = readRepoFile("src/Timeline.tsx");
    assert.match(tl, /import\s+\{\s*MermaidView\s*\}\s+from\s+"\.\/MermaidView"/);
    assert.match(tl, /tok\.lang\.trim\(\)\.toLowerCase\(\)\s*===\s*"mermaid"/);
    assert.match(tl, /<MermaidView\b/);
  });

  test("BriefEditor.tsx wires <MermaidView> and preview mode for ```mermaid blocks", () => {
    const be = readRepoFile("src/BriefEditor.tsx");
    assert.match(be, /import\s+\{\s*MermaidView\s*\}\s+from\s+"\.\/MermaidView"/);
    assert.match(be, /<MermaidView\b/);
    assert.match(be, /<MarkdownRenderer\b/);
  });
});

// Edge-label halo rects (the `<rect>` inside each `<g class="mermaid-edge-label">`).
function edgeLabelRects(svg) {
  const out = [];
  const re = /<g class="mermaid-edge-label">\s*<rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g;
  let m;
  while ((m = re.exec(svg))) out.push({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] });
  return out;
}

function anyRectOverlap(rects) {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0 && oy > 0) return true;
    }
  }
  return false;
}

// Node bounding boxes (rect / circle / diamond-polygon first shapes of each node group).
function nodeBoxes(svg) {
  const out = [];
  let m;
  const rectRe = /<g class="mermaid-node"[^>]*>\s*<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g;
  while ((m = rectRe.exec(svg))) out.push({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] });
  const circleRe = /<g class="mermaid-node"[^>]*>\s*<circle cx="([-\d.]+)" cy="([-\d.]+)" r="([-\d.]+)"/g;
  while ((m = circleRe.exec(svg))) {
    const r = +m[3];
    out.push({ x: +m[1] - r, y: +m[2] - r, w: 2 * r, h: 2 * r });
  }
  const polyRe = /<g class="mermaid-node"[^>]*>\s*<polygon points="([^"]*)"/g;
  while ((m = polyRe.exec(svg))) {
    const nums = m[1].split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      minX = Math.min(minX, nums[i]);
      maxX = Math.max(maxX, nums[i]);
      minY = Math.min(minY, nums[i + 1]);
      maxY = Math.max(maxY, nums[i + 1]);
    }
    out.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
  }
  return out;
}

function anyPairOverlap(a, b) {
  for (const ra of a) {
    for (const rb of b) {
      const ox = Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x);
      const oy = Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y);
      if (ox > 0 && oy > 0) return true;
    }
  }
  return false;
}

// Assert a diagram's edge labels never overlap each other nor any node.
function assertLabelsClear(code, expectedLabelCount) {
  const res = renderMermaidSvg(code);
  assert.equal(res.ok, true);
  const labels = edgeLabelRects(res.svg);
  assert.equal(labels.length, expectedLabelCount);
  assert.equal(anyRectOverlap(labels), false, "edge labels overlap each other");
  assert.equal(anyPairOverlap(labels, nodeBoxes(res.svg)), false, "edge label overlaps a node");
}

describe("V1 MermaidView — theme palette", () => {
  test("light theme renders a light canvas, light node fill and ink text; dark is preserved by default", () => {
    const code = "flowchart TD\n  A[Start] -->|yes| B[End]\n  B --> C{C}";
    const light = renderMermaidSvg(code, "light");
    assert.equal(light.ok, true);
    assert.match(light.svg, /fill="#f6f4f1"/); // light canvas
    assert.match(light.svg, /fill="#ffffff"/); // light node fill
    assert.match(light.svg, /fill="#2b1840"/); // light text
    assert.doesNotMatch(light.svg, /fill="#0c0d1b"/); // no dark canvas
    assert.doesNotMatch(light.svg, /fill="#181b34"/); // no dark node fill
    assert.doesNotMatch(light.svg, /fill="#f1f5ff"/); // no dark node text

    const dark = renderMermaidSvg(code);
    assert.match(dark.svg, /fill="#0c0d1b"/);
    assert.match(dark.svg, /fill="#181b34"/);
  });

  test("sequence diagram light theme is light too", () => {
    const code = "sequenceDiagram\n  A->>B: Ping";
    const light = renderMermaidSvg(code, "light");
    assert.equal(light.ok, true);
    assert.match(light.svg, /fill="#f6f4f1"/);
    assert.doesNotMatch(light.svg, /fill="#0c0d1b"/);
  });
});

describe("V1 MermaidView — edge labels never overlap (idea-843)", () => {
  test("TD fan-out: one source, three labeled targets", () => {
    assertLabelsClear(
      [
        "flowchart TD",
        '  A["Quest step"]',
        "  A -->|involves location| L1([The Old Mines])",
        "  A -->|involves character| C1((Foreman))",
        "  A -->|requires item| I1(Key)",
      ].join("\n"),
      3,
    );
  });

  test("TD fan-in: three sources, one shared target", () => {
    assertLabelsClear(
      [
        "flowchart TD",
        '  S1["Source one"] -->|provides item| T[Target]',
        '  S2["Source two"] -->|provides gold| T',
        '  S3["Source three"] -->|provides key| T',
      ].join("\n"),
      3,
    );
  });

  test("parallel edges between the same two nodes stack cleanly", () => {
    assertLabelsClear(
      [
        "flowchart TD",
        "  A[Start] -->|first path| B[End]",
        "  A -->|second path| B",
        "  A -->|third path| B",
      ].join("\n"),
      3,
    );
  });

  test("TD parallel-6: six labels on one edge never stack or hit nodes", () => {
    assertLabelsClear(
      [
        "flowchart TD",
        "  A[Start] -->|first path| B[End]",
        "  A -->|second path| B",
        "  A -->|third path| B",
        "  A -->|fourth path| B",
        "  A -->|fifth path| B",
        "  A -->|sixth path| B",
      ].join("\n"),
      6,
    );
  });

  test("LR fan-out-3: labels clear the source and target nodes", () => {
    assertLabelsClear(
      [
        "flowchart LR",
        '  A["Quest step"]',
        "  A -->|involves location| L1([The Old Mines])",
        "  A -->|involves character| C1((Foreman))",
        "  A -->|requires item| I1(Key)",
      ].join("\n"),
      3,
    );
  });

  test("LR fan-in-3: labels clear the shared target and sources", () => {
    assertLabelsClear(
      [
        "flowchart LR",
        '  S1["Source one"] -->|provides item| T[Target]',
        '  S2["Source two"] -->|provides gold| T',
        '  S3["Source three"] -->|provides key| T',
      ].join("\n"),
      3,
    );
  });

  test("LR fan-out-6: six labels from one source clear every node", () => {
    assertLabelsClear(
      [
        "flowchart LR",
        '  A["Quest step"]',
        "  A -->|involves location| L1([Loc])",
        "  A -->|involves character| C1((Char))",
        "  A -->|requires item| I1(Item)",
        "  A -->|requires skill| S1(Skill)",
        "  A -->|opens room| R1([Room])",
        "  A -->|defeats enemy| E1((Enemy))",
      ].join("\n"),
      6,
    );
  });
});
