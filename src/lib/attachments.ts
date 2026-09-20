import type { Attachment, AttachmentKind } from "./types";
import type { ModelCapabilities } from "./capabilities";
import { transcribeAudioFile } from "./onniroute";
import { newId } from "./store";

/** Lazy: pdfjs-dist is only needed once a user actually attaches a PDF, and
 *  otherwise costs every visitor ~364KB of eager first-load JS for nothing. */
let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([mod, worker]) => {
      mod.GlobalWorkerOptions.workerSrc = worker.default;
      return mod;
    });
  }
  return pdfjsPromise;
}

/** Lazy for the same reason as pdfjs-dist above - only needed for .doc/.docx. */
let mammothPromise: Promise<typeof import("mammoth")> | null = null;
function loadMammoth() {
  if (!mammothPromise) mammothPromise = import("mammoth");
  return mammothPromise;
}

export const FILE_KIND_META: Record<
  AttachmentKind,
  { label: string; accept: string; hint: string }
> = {
  image: {
    label: "Images",
    accept: "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml",
    hint: "png, jpg, webp, gif, bmp, svg",
  },
  document: {
    label: "Document",
    accept: ".pdf,.doc,.docx,.rtf,.odt,.txt,.md,.markdown,.csv,.json,.html,.htm,.xml,.yaml,.yml,.log,.diff,.patch",
    hint: "pdf, doc, docx, rtf, odt, text & more",
  },
  text: {
    label: "Text file",
    accept: ".txt,.md,.markdown,.csv,.json,.js,.jsx,.ts,.tsx,.py,.html,.htm,.xml,.yaml,.yml,.css,.scss,.less,.sh,.bat,.ps1,.sql,.java,.c,.cpp,.h,.hpp,.rb,.go,.rs,.php,.swift,.kt,.toml,.ini,.cfg,.conf,.log,.diff,.patch,.env,.gitignore",
    hint: "plain text & source code",
  },
  audio: {
    label: "Audio",
    accept: "audio/mpeg,audio/wav,audio/mp4,audio/ogg,audio/flac,audio/webm,audio/aac,.mp3,.wav,.m4a,.ogg,.flac,.webm,.aac,.opus",
    hint: "transcribed to text first",
  },
};

export const FILE_KIND_ORDER: AttachmentKind[] = ["image", "document", "text", "audio"];

/** Which file kinds a model's capabilities allow. */
export function supportedKinds(caps: ModelCapabilities): AttachmentKind[] {
  const kinds: AttachmentKind[] = ["text", "document"];
  if (caps.vision) kinds.push("image");
  kinds.push("audio"); // audio is transcribed to text, model-agnostic
  return kinds;
}

const EXT_KIND: Record<string, AttachmentKind> = {
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", bmp: "image", svg: "image",
  pdf: "document",
  docx: "document",
  doc: "document",
  rtf: "document",
  odt: "document",
  txt: "text", md: "text", markdown: "text", csv: "text", json: "text", js: "text", jsx: "text",
  ts: "text", tsx: "text", py: "text", html: "text", htm: "text", xml: "text", yaml: "text", yml: "text",
  css: "text", scss: "text", less: "text", sh: "text", bat: "text", ps1: "text", sql: "text",
  java: "text", c: "text", cpp: "text", h: "text", hpp: "text", rb: "text", go: "text", rs: "text",
  php: "text", swift: "text", kt: "text", toml: "text", ini: "text", cfg: "text", conf: "text",
  log: "text", diff: "text", patch: "text", env: "text", gitignore: "text",
  mp3: "audio", wav: "audio", m4a: "audio", ogg: "audio", flac: "audio", webm: "audio", aac: "audio", opus: "audio",
};

/** Guesses an AttachmentKind from a MIME type alone, with no filename/extension
 *  to go on - the only signal available while something is still being
 *  dragged (browsers withhold the real File, and its name, until drop). */
export function kindFromMimeType(mime: string): AttachmentKind | null {
  const lower = mime.toLowerCase();
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("audio/")) return "audio";
  if (lower === "application/pdf" || lower === "application/msword" || lower.includes("wordprocessingml")) return "document";
  if (lower.startsWith("text/")) return "text";
  return null;
}

export function kindFromFile(file: File): AttachmentKind | null {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (EXT_KIND[ext]) return EXT_KIND[ext];
  return kindFromMimeType(file.type);
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Providers cap image longest-edge around 2000-2600px and silently
 *  downscale beyond that (e.g. Claude ~2576px) — so resizing before
 *  base64-encoding saves upload bytes and completion-context tokens with
 *  no visible quality loss. */
const MAX_IMAGE_EDGE = 2048;
const IMAGE_JPEG_QUALITY = 0.85;
/** Byte target the iterative compression loop below aims for. A mitigation,
 *  not a proven fix, for large image payloads being the most likely thing to
 *  trip a transport-level cap/drop on a constrained relay or community-tier
 *  provider — most everyday screenshots/photos never reach this after the
 *  first-pass encode below and pass through untouched. */
const IMAGE_TARGET_BYTES = 1.5 * 1024 * 1024;
const MIN_JPEG_QUALITY = 0.5;
/** Never shrink below this edge length just to hit the byte target. */
const MIN_JPEG_EDGE = 768;
const MAX_COMPRESSION_ITERATIONS = 6;

/** Cheap approximate alpha check — samples a handful of representative
 *  pixels (corners + center) rather than scanning the whole image, since
 *  this only needs to answer "is flattening to JPEG safe here or not."
 *  Fails toward "yes, treat as transparent" (keep PNG) if sampling itself
 *  fails, since a wrongly-flattened image is worse than a wrongly-kept-large
 *  one. */
function canvasHasTransparency(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx) return true;
  const { width, height } = canvas;
  const points: [number, number][] = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
    [Math.floor(width / 2), Math.floor(height / 2)],
  ];
  try {
    for (const [x, y] of points) {
      const alpha = ctx.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data[3];
      if (alpha < 255) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** Resize (and, when it won't visibly matter, re-compress) an image data URL
 *  so it stays well under IMAGE_TARGET_BYTES. Always caps the longest side at
 *  MAX_IMAGE_EDGE first; a PNG/GIF source that samples as having real
 *  transparency is kept as PNG untouched (converting it to JPEG would
 *  flatten transparent regions onto black), everything else iteratively
 *  steps JPEG quality then edge length down until it fits the target or the
 *  floors are hit. Fails open (returns the original) on any error, since a
 *  slightly larger upload is far better than a dropped image. */
export function downscaleImageDataUrl(dataUrl: string): Promise<string> {
  if (dataUrl.startsWith("data:image/svg")) return Promise.resolve(dataUrl); // vector — no benefit
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const { width, height } = img;
        const longest = Math.max(width, height);
        const needsResize = Boolean(longest) && longest > MAX_IMAGE_EDGE;
        if (!needsResize && dataUrlBytes(dataUrl) <= IMAGE_TARGET_BYTES) {
          resolve(dataUrl); // already small enough — don't touch it
          return;
        }

        const drawAt = (edge: number): HTMLCanvasElement | null => {
          const scale = longest > edge ? edge / longest : 1;
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const ctx = canvas.getContext("2d");
          if (!ctx) return null;
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          return canvas;
        };

        let canvas = drawAt(MAX_IMAGE_EDGE);
        if (!canvas) {
          resolve(dataUrl);
          return;
        }

        const isPngLike = dataUrl.startsWith("data:image/png") || dataUrl.startsWith("data:image/gif");
        if (isPngLike && canvasHasTransparency(canvas)) {
          resolve(canvas.toDataURL("image/png"));
          return;
        }

        // No transparency to protect (or not a PNG/GIF source) — free to
        // re-encode as JPEG, stepping quality then resolution down until the
        // result fits the byte target or both floors are hit.
        let edge = Math.max(canvas.width, canvas.height);
        let quality = IMAGE_JPEG_QUALITY;
        let encoded = canvas.toDataURL("image/jpeg", quality);
        for (let i = 0; i < MAX_COMPRESSION_ITERATIONS && dataUrlBytes(encoded) > IMAGE_TARGET_BYTES; i++) {
          if (quality > MIN_JPEG_QUALITY) {
            quality = Math.max(MIN_JPEG_QUALITY, quality - 0.1);
          } else if (edge > MIN_JPEG_EDGE) {
            edge = Math.max(MIN_JPEG_EDGE, Math.round(edge * 0.8));
            const next = drawAt(edge);
            if (!next) break;
            canvas = next;
            quality = IMAGE_JPEG_QUALITY;
          } else {
            break; // both floors hit — accept whatever we have
          }
          encoded = canvas.toDataURL("image/jpeg", quality);
        }
        resolve(encoded);
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export interface PdfResult {
  text: string;
  pages: string[];
}

/** Extract PDF text; if the PDF has no text layer, rasterize pages to images. */
export async function extractPdf(file: File, maxPages = 8): Promise<PdfResult> {
  const { getDocument } = await loadPdfjs();
  const data = await file.arrayBuffer();
  const doc = await getDocument({ data }).promise;
  const pageCount = Math.min(doc.numPages, maxPages);
  let text = "";
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => (typeof (item as { str?: unknown }).str === "string" ? (item as { str: string }).str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    text += pageText ? pageText + "\n\n" : "";
  }

  const meaningful = text.replace(/\s+/g, " ").trim();
  if (meaningful.length >= 80) {
    return { text: meaningful, pages: [] };
  }

  // Scanned PDF — render pages as JPEG images for vision models.
  const pages: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.6 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    await page.render({ canvasContext: ctx, viewport }).promise;
    pages.push(canvas.toDataURL("image/jpeg", 0.85));
  }
  return { text: "", pages };
}

export interface DocResult {
  text: string;
  images: string[];
}

/** Detect whether an ArrayBuffer is a zip-based OOXML (.docx/.xlsx). */
function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Detect the legacy Microsoft OLE compound file signature (.doc). */
function isOle(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

/**
 * Best-effort text extraction from a legacy binary Word (.doc) file. Word 2003
 * stores text runs in UTF-16LE in the WordDocument stream; we scan the whole
 * buffer for runs of printable characters (covers the common case reasonably,
 * and is far more reliable than feeding a binary blob to mammoth). Falls back
 * to mammoth's own attempt, then returns a clear message if nothing was found.
 */
export async function extractDoc(file: File): Promise<DocResult> {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  // .docx is a zip — route it to the docx extractor.
  if (isZip(bytes)) return extractDocx(file);

  if (isOle(bytes)) {
    // Word 97-2003 text runs are UTF-16LE; extract printable runs.
    const chunks: string[] = [];
    const dv = new DataView(arrayBuffer);
    let run = "";
    const flush = () => {
      if (run.replace(/[\x00-\x1f\x7f]/g, "").trim().length >= 4) chunks.push(run.trim());
      run = "";
    };
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      let code = dv.getUint16(i, true);
      // Skip the non-text stream garbage; keep printable-ish code points.
      if (code === 0 || code === 0x0a || code === 0x0d) {
        flush();
        if (code === 0x0d) chunks.push("\n");
      } else if ((code >= 0x20 && code <= 0x7e) || code >= 0xa0) {
        run += String.fromCharCode(code);
      } else {
        flush();
      }
      if (run.length > 4096) flush();
    }
    flush();
    const text = (chunks.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")).trim();
    if (text.length >= 40) return { text, images: [] };
  }

  // Fallback: let mammoth try (it can occasionally parse simple .doc files).
  try {
    const mammoth = await loadMammoth();
    const result = await mammoth.extractRawText({ arrayBuffer });
    const text = (result.value || "").trim();
    if (text) return { text, images: [] };
  } catch {
    /* ignore — fall through to error */
  }
  throw new Error(
    "This appears to be a legacy binary .doc file that couldn't be read in the browser. " +
    "Save it as .docx (or a PDF) and try again."
  );
}

/** Extract text AND embedded images from a .docx (OOXML zip) via mammoth. */
export async function extractDocx(file: File): Promise<DocResult> {
  const mammoth = await loadMammoth();
  const arrayBuffer = await file.arrayBuffer();
  const text = await mammoth.extractRawText({ arrayBuffer }).then((r) => r.value || "");

  const images: string[] = [];
  // mammoth embeds embedded images as base64 data URLs directly in the HTML it
  // produces, so we can pull every picture out without a zip dependency.
  try {
    const html = await mammoth.convertToHtml({ arrayBuffer });
    const srcs = html.value.match(/src="(data:image\/[^"]+)"/g) || [];
    for (const token of srcs) {
      const url = token.slice(5, -1);
      if (url) images.push(url);
    }
  } catch {
    /* embedded-image extraction is best-effort */
  }
  return { text: text.trim(), images };
}

/** Convert a dropped/selected File into a ready-to-attach Attachment. */
export async function buildAttachment(file: File): Promise<Attachment> {
  const base: Attachment = {
    id: newId(),
    kind: "text",
    name: file.name,
    size: file.size,
  };
  const kind = kindFromFile(file);
  if (!kind) {
    return { ...base, error: `Unsupported file type (${file.type || "unknown"})` };
  }
  base.kind = kind;

  if (kind === "image") {
    base.dataUrl = await downscaleImageDataUrl(await fileToDataUrl(file));
  } else if (kind === "document") {
    const { text, images, pages } = await extractDocument(file);
    base.text = text;
    base.images = images;
    base.pages = pages;
  } else if (kind === "audio") {
    base.transcript = await transcribeAudioFile(file, file.name);
  } else {
    base.text = await file.text();
  }
  return base;
}

/** Detect the kind of document (pdf / docx / doc) a file represents. */
function isPdf(file: File): boolean {
  const mime = file.type.toLowerCase();
  if (mime === "application/pdf") return true;
  return (file.name.split(".").pop() || "").toLowerCase() === "pdf";
}

/** Extract text/images from any supported document (PDF, .docx, legacy .doc). */
export async function extractDocument(file: File): Promise<DocResult & { pages: string[] }> {
  if (isPdf(file)) {
    const result = await extractPdf(file);
    return { text: result.text, images: [], pages: result.pages };
  }
  // Word documents (.docx and legacy .doc; extractDoc routes by magic bytes).
  const result = await extractDoc(file);
  return { text: result.text, images: result.images, pages: [] };
}

/** Approximate byte size of a base64 data URL payload. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return 0;
  return Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}