export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape plain text and render `inline code` as <code>. */
function inlineHtml(input: string): string {
  return escapeHtml(input).replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

export type Block =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "html"; text: string };

const FENCE = "```";

/** Split a message into text and fenced-code blocks. */
export function parseBlocks(markdown: string): Block[] {
  const segments = markdown.split(FENCE);
  const blocks: Block[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? "";
    if (i % 2 === 1) {
      // strip a leading language hint on the first line
      const cleaned = seg.replace(/^[a-zA-Z0-9_+#.-]*\r?\n/, "");
      const text = cleaned.replace(/\s+$/, "");
      if (text.length > 0) blocks.push({ kind: "code", text });
    } else if (seg.trim().length > 0) {
      blocks.push({ kind: "text", text: seg.replace(/\s+$/, "") });
    }
  }
  return blocks;
}

function renderBlockHtml(block: Block): string {
  if (block.kind === "code") return `<pre>${escapeHtml(block.text)}</pre>`;
  return inlineHtml(block.text);
}

const TG_LIMIT = 4096;
const TARGET = 3900;

/** Pack blocks into as few Telegram-sized HTML messages as possible. */
export function packBlocks(blocks: Block[], banners: Block[] = []): string[] {
  const messages: string[] = [];
  let current = "";

  const push = () => {
    if (current.trim().length > 0) messages.push(current.trim());
    current = "";
  };

  const items: Block[] = [...banners, ...blocks];

  for (const block of items) {
    if (block.kind === "html") {
      const rendered = block.text + "\n\n";
      if (current.length + rendered.length > TARGET) push();
      current += rendered;
      continue;
    }
    if (block.kind === "text") {
      const paragraphs = block.text.split(/\n{2,}/);
      for (const para of paragraphs) {
        const rendered = inlineHtml(para) + "\n\n";
        if (current.length + rendered.length > TARGET) {
          push();
        }
        if (rendered.length > TARGET) {
          // extremely long single paragraph: hard wrap on line boundaries
          for (const line of wrapLong(para, TARGET)) {
            const r = inlineHtml(line) + "\n";
            if (current.length + r.length > TARGET) push();
            current += r;
          }
        } else {
          current += rendered;
        }
      }
    } else {
      const rendered = renderBlockHtml(block) + "\n\n";
      const plainLen = block.text.length;
      if (plainLen + 20 <= TARGET && current.length + rendered.length > TARGET) {
        push();
      }
      if (rendered.length <= TG_LIMIT) {
        current += rendered;
      } else {
        // split the code block itself into multiple <pre> chunks
        push();
        let offset = 0;
        while (offset < block.text.length) {
          const slice = block.text.slice(offset, offset + TARGET - 20);
          messages.push(`<pre>${escapeHtml(slice)}</pre>`);
          offset += slice.length;
        }
      }
    }
    if (current.length >= TG_LIMIT) push();
  }
  push();
  if (messages.length === 0) messages.push("(nessun contenuto)");
  return messages;
}

function wrapLong(text: string, max: number): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= max) {
      out.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > max) {
      out.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    out.push(rest);
  }
  return out;
}

export function tail(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(text.length - max), truncated: true };
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return truncate(flat, max);
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s fa`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m fa`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h fa`;
  const d = Math.round(h / 24);
  return `${d}g fa`;
}

export function shortSessionId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}
