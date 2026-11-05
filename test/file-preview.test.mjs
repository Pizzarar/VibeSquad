import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Register a lightweight TSX/TS loader backed by Vite's OXC transform so Node can import src/FilePreview.tsx directly.
const viteUrl = import.meta.resolve("vite");
const hookSource = `
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from ${JSON.stringify(viteUrl)};

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.startsWith(".") && !/\\.[a-z0-9]+$/i.test(specifier)) {
      for (const ext of [".ts", ".tsx"]) {
        try { return await nextResolve(specifier + ext, context); } catch {}
      }
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".tsx") || url.endsWith(".ts")) {
    const filePath = fileURLToPath(url);
    const raw = await readFile(filePath, "utf8");
    const { code } = await transformWithOxc(raw, filePath);
    return { format: "module", shortCircuit: true, source: code };
  }
  return nextLoad(url, context);
}
`;
register(
  `data:text/javascript;base64,${Buffer.from(hookSource).toString("base64")}`,
  pathToFileURL(`${process.cwd()}/`),
);

const FP = await import("../src/FilePreview.tsx");
const readSrc = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("classifyPreviewKind: classifies image, markdown, html, pdf, audio, video, text, and binary extensions", () => {
  // Images
  for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "PNG", "SVG"]) {
    assert.equal(FP.classifyPreviewKind(`assets/logo.${ext}`), "image", `.${ext} should be image`);
  }

  // Markdown
  assert.equal(FP.classifyPreviewKind("README.md"), "markdown");
  assert.equal(FP.classifyPreviewKind("docs/guide.markdown"), "markdown");
  assert.equal(FP.classifyPreviewKind("NOTES.MD"), "markdown");

  // HTML
  assert.equal(FP.classifyPreviewKind("index.html"), "html");
  assert.equal(FP.classifyPreviewKind("public/page.htm"), "html");
  assert.equal(FP.classifyPreviewKind("VIEW.HTML"), "html");

  // PDF
  assert.equal(FP.classifyPreviewKind("docs/spec.pdf"), "pdf");
  assert.equal(FP.classifyPreviewKind("REPORT.PDF"), "pdf");

  // Audio
  for (const ext of ["mp3", "wav", "ogg", "m4a", "MP3", "WAV"]) {
    assert.equal(FP.classifyPreviewKind(`media/clip.${ext}`), "audio", `.${ext} should be audio`);
  }

  // Video
  for (const ext of ["mp4", "webm", "mov", "MP4", "WEBM", "MOV"]) {
    assert.equal(FP.classifyPreviewKind(`video/demo.${ext}`), "video", `.${ext} should be video`);
  }

  // Code / Text
  for (const ext of ["ts", "tsx", "js", "jsx", "mjs", "json", "css", "txt", "yml", "py", "rs"]) {
    assert.equal(FP.classifyPreviewKind(`src/mod.${ext}`), "text", `.${ext} should be text`);
  }

  // Binary
  for (const ext of ["bin", "exe", "dll", "zip", "gz", "tar", "wasm", "woff2"]) {
    assert.equal(FP.classifyPreviewKind(`dist/blob.${ext}`), "binary", `.${ext} should be binary`);
  }
});

test("classifyPreviewKind: MIME fallbacks when extension is missing or unknown", () => {
  assert.equal(FP.classifyPreviewKind("Makefile", "image/png"), "image");
  assert.equal(FP.classifyPreviewKind("icon", "image/svg+xml; charset=utf-8"), "image");
  assert.equal(FP.classifyPreviewKind("doc", "text/markdown"), "markdown");
  assert.equal(FP.classifyPreviewKind("doc", "text/x-markdown"), "markdown");
  assert.equal(FP.classifyPreviewKind("page", "text/html; charset=utf-8"), "html");
  assert.equal(FP.classifyPreviewKind("manual", "application/pdf"), "pdf");
  assert.equal(FP.classifyPreviewKind("sound", "audio/mpeg"), "audio");
  assert.equal(FP.classifyPreviewKind("sound", "audio/ogg"), "audio");
  assert.equal(FP.classifyPreviewKind("clip", "video/mp4"), "video");
  assert.equal(FP.classifyPreviewKind("clip", "video/webm"), "video");
  assert.equal(FP.classifyPreviewKind("raw", "application/octet-stream"), "binary");
  assert.equal(FP.classifyPreviewKind("archive", "application/zip"), "binary");
  assert.equal(FP.classifyPreviewKind("README", "text/plain"), "text");
  assert.equal(FP.classifyPreviewKind("config", "application/json"), "text");
  // .ts stays text even if a server guesses video/mp2t
  assert.equal(FP.classifyPreviewKind("src/index.ts", "video/mp2t"), "text");
});

test("inferMimeType: resolves canonical MIME from extension and providedMime", () => {
  assert.equal(FP.inferMimeType("a/b/pic.png"), "image/png");
  assert.equal(FP.inferMimeType("a/b/pic.jpg"), "image/jpeg");
  assert.equal(FP.inferMimeType("a/b/pic.jpeg"), "image/jpeg");
  assert.equal(FP.inferMimeType("a/b/anim.gif"), "image/gif");
  assert.equal(FP.inferMimeType("a/b/hero.webp"), "image/webp");
  assert.equal(FP.inferMimeType("a/b/icon.svg"), "image/svg+xml");
  assert.equal(FP.inferMimeType("a/b/icon.svg", "text/plain"), "image/svg+xml");
  assert.equal(FP.inferMimeType("a/b/favicon.ico"), "image/x-icon");
  assert.equal(FP.inferMimeType("a/b/bitmap.bmp"), "image/bmp");
  assert.equal(FP.inferMimeType("README.md", "text/plain"), "text/markdown");
  assert.equal(FP.inferMimeType("index.html", "text/plain"), "text/html");
  assert.equal(FP.inferMimeType("manual.pdf", "application/octet-stream"), "application/pdf");
  assert.equal(FP.inferMimeType("song.mp3", "application/octet-stream"), "audio/mpeg");
  assert.equal(FP.inferMimeType("voice.wav"), "audio/wav");
  assert.equal(FP.inferMimeType("voice.ogg"), "audio/ogg");
  assert.equal(FP.inferMimeType("voice.m4a"), "audio/mp4");
  assert.equal(FP.inferMimeType("clip.mp4"), "video/mp4");
  assert.equal(FP.inferMimeType("clip.webm"), "video/webm");
  assert.equal(FP.inferMimeType("clip.mov"), "video/quicktime");
  assert.equal(FP.inferMimeType("unknown", "image/webp; charset=binary"), "image/webp");
  assert.equal(FP.inferMimeType("unknown.bin"), "application/octet-stream");
});

test("bytesToDataUrl: handles Uint8Array, number[], base64 strings, and raw SVG UTF-8 text", () => {
  const pngMagic = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const expectedPngB64 = Buffer.from(pngMagic).toString("base64");

  // Uint8Array
  assert.equal(
    FP.bytesToDataUrl(pngMagic, "image/png"),
    `data:image/png;base64,${expectedPngB64}`,
  );

  // number[]
  assert.equal(
    FP.bytesToDataUrl([0x89, 0x50, 0x4e, 0x47], "image/png"),
    `data:image/png;base64,${expectedPngB64}`,
  );

  // Base64 string
  assert.equal(
    FP.bytesToDataUrl(expectedPngB64, "image/png"),
    `data:image/png;base64,${expectedPngB64}`,
  );

  // Already a data URL
  const existingDataUrl = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
  assert.equal(FP.bytesToDataUrl(existingDataUrl, "image/gif"), existingDataUrl);

  // Raw SVG UTF-8 text
  const svgText = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10"/></svg>';
  const svgUrl = FP.bytesToDataUrl(svgText, "image/svg+xml");
  assert.ok(svgUrl.startsWith("data:image/svg+xml;base64,"), "SVG data URL has image/svg+xml prefix");
  const decodedSvg = Buffer.from(svgUrl.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
  assert.equal(decodedSvg, svgText);
});

test("isSourceToggleable and formatFileSize helpers", () => {
  assert.equal(FP.isSourceToggleable("README.md"), true);
  assert.equal(FP.isSourceToggleable("docs/notes.markdown"), true);
  assert.equal(FP.isSourceToggleable("index.html"), true);
  assert.equal(FP.isSourceToggleable("page.htm"), true);
  assert.equal(FP.isSourceToggleable("logo.svg"), true);
  assert.equal(FP.isSourceToggleable("photo.png"), false);
  assert.equal(FP.isSourceToggleable("doc.pdf"), false);
  assert.equal(FP.isSourceToggleable("src/App.tsx"), false);

  assert.equal(FP.formatFileSize(0), "0 B");
  assert.equal(FP.formatFileSize(512), "512 B");
  assert.equal(FP.formatFileSize(2048), "2.0 KB");
  assert.equal(FP.formatFileSize(15 * 1024), "15 KB");
  assert.equal(FP.formatFileSize(2 * 1024 * 1024), "2.00 MB");
});

test("HTML preview sandboxing: strips scripts/handlers and enforces empty sandbox attribute", () => {
  assert.equal(FP.HTML_PREVIEW_SANDBOX, "");

  const untrusted = `<!doctype html><html><body><h1 onclick="alert(1)">Hello</h1><script>window.parent.postMessage('pwn','*')</script><a href="javascript:alert(2)">Click</a></body></html>`;
  const clean = FP.sanitizeHtmlPreview(untrusted);
  assert.ok(!/<script/i.test(clean), "script tags stripped");
  assert.ok(!/onclick=/i.test(clean), "inline event handlers stripped");
  assert.ok(!/javascript:/i.test(clean), "javascript: URLs neutralized");
  assert.ok(clean.includes("<h1>Hello</h1>"), "safe markup preserved");

  const props = FP.getHtmlPreviewIframeProps(untrusted, "index.html");
  assert.equal(props.sandbox, "", "sandbox attribute is strictly empty");
  assert.ok(!props.sandbox.includes("allow-scripts"), "never allows scripts");
  assert.ok(!props.sandbox.includes("allow-same-origin"), "never allows same-origin");

  const previewSrc = readSrc("src/FilePreview.tsx");
  assert.match(previewSrc, /data-testid="file-preview-html"/);
  assert.match(previewSrc, /sandbox=""/);
  assert.doesNotMatch(previewSrc, /allow-scripts/);
  assert.doesNotMatch(previewSrc, /allow-same-origin/);
});

test("FilePreview component source includes all required preview testids and controls", () => {
  const s = readSrc("src/FilePreview.tsx");
  assert.match(s, /data-testid="file-preview-image"/);
  assert.match(s, /data-testid="file-preview-markdown"/);
  assert.match(s, /data-testid="file-preview-html"/);
  assert.match(s, /data-testid="file-preview-pdf"/);
  assert.match(s, /data-testid="file-preview-audio"/);
  assert.match(s, /data-testid="file-preview-video"/);
  assert.match(s, /data-testid="file-preview-binary"/);
  assert.match(s, /Binary file — preview not available/);
  // Image zoom controls
  assert.match(s, /Fit/);
  assert.match(s, /100%/);
});

test("FilesPanel wiring: preserves bytes/mime, renders FilePreview, toggles Preview/Source for .md/.html/.svg", () => {
  const fp = readSrc("src/FilesPanel.tsx");
  assert.match(fp, /import\s*\{[\s\S]*FilePreview[\s\S]*\}\s*from\s*"\.\/FilePreview"/);
  assert.match(fp, /setFileBytes\(result\.bytes\)/);
  assert.match(fp, /setFileMime\(resolvedMime\)/);
  assert.match(fp, /<FilePreview[\s\S]*filePath=\{openFile\}/);
  assert.match(fp, /data-testid="files-source-btn"/);
  assert.match(fp, /isSourceToggleable\(openFile/);
  assert.match(fp, /Switch to Source to select lines\./);
});
