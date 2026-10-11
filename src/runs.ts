import type { Api } from "grammy";
import type { V2Event } from "@opencode/client";
import { createLogger } from "./logger.js";
import {
  escapeHtml,
  oneLine,
  packBlocks,
  parseBlocks,
  tail,
  type Block,
} from "./format.js";

const log = createLogger("engine");

interface EventShape {
  type: string;
  data?: Record<string, unknown>;
  location?: { directory?: string };
}

export interface ToolView {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  detail?: string;
}

interface Run {
  sessionID: string;
  /** Telegram chats receiving this run, mapped to their message id (once sent). */
  targets: Map<number, number | undefined>;
  /** True when the run was detected from OpenCode (prompt sent outside Telegram). */
  observed: boolean;
  agent?: string;
  model?: string;
  textParts: Map<number, string>;
  reasoningParts: Map<number, string>;
  tools: Map<string, ToolView>;
  toolOrder: string[];
  finishNote?: string;
  dirty: boolean;
  finished: boolean;
  startedAt: number;
  lastRendered: string;
  finalizeTimer?: NodeJS.Timeout;
}

export interface EngineOptions {
  /** Resolves the Telegram API (bound late, once the bot exists). */
  api: () => Api;
  intervalMs: number;
  /** Chats that currently have this session selected. */
  chatsForSession: (sessionID: string) => { chatId: number; notify: boolean }[];
  /** All chats allowed to interact with the bot (for blocking permissions). */
  allChats: () => number[];
}

const WAITING_FOOTER =
  "⏸️ <i>In attesa del tuo input: rispondi con un messaggio per continuare.</i>";

export class SessionEngine {
  private runs = new Map<string, Run>();
  private permissions = new Map<string, { sessionID: string; requestID: string }>();
  private permCounter = 0;
  private timer: NodeJS.Timeout;

  constructor(private readonly opts: EngineOptions) {
    this.timer = setInterval(() => void this.tick(), opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  hasRun(sessionID: string): boolean {
    return this.runs.has(sessionID);
  }

  private createRun(sessionID: string, observed: boolean): Run {
    return {
      sessionID,
      targets: new Map(),
      observed,
      textParts: new Map(),
      reasoningParts: new Map(),
      tools: new Map(),
      toolOrder: [],
      dirty: false,
      finished: false,
      startedAt: Date.now(),
      lastRendered: "",
    };
  }

  /** Called right before a prompt is dispatched, to start streaming into chat. */
  async begin(sessionID: string, chatId: number): Promise<number | undefined> {
    const run = this.createRun(sessionID, false);
    // register immediately so the execution.started notification is suppressed
    this.runs.set(sessionID, run);
    // No placeholder is sent up front: the first message appears only when the
    // agent produces real output, so sending an input does not trigger an
    // immediate (and useless) Telegram notification.
    this.attachTarget(run, chatId);
    return undefined;
  }

  /** Register a chat as a silent target of the run (no placeholder message). */
  private attachTarget(run: Run, chatId: number): void {
    run.targets.set(chatId, undefined);
  }

  /**
   * Attach observers for a run detected from OpenCode (prompt sent elsewhere).
   * Only chats with this session selected and notifications enabled are notified.
   */
  private async attachObservers(
    run: Run,
    chats: { chatId: number; notify: boolean }[],
  ): Promise<void> {
    for (const { chatId } of chats) {
      if (this.runs.get(run.sessionID) !== run) return;
      this.attachTarget(run, chatId);
    }
  }

  /** Drop a run that never actually started (e.g. prompt rejected). */
  abort(sessionID: string): void {
    const run = this.runs.get(sessionID);
    if (!run) return;
    if (run.finalizeTimer) clearTimeout(run.finalizeTimer);
    this.runs.delete(sessionID);
  }

  resolvePermission(
    token: string,
  ): { sessionID: string; requestID: string } | undefined {
    const val = this.permissions.get(token);
    if (val) this.permissions.delete(token);
    return val;
  }

  onEvent(event: V2Event): void {
    const ev = event as unknown as EventShape;
    const data = (ev.data ?? {}) as Record<string, any>;
    const sid: string | undefined =
      typeof data.sessionID === "string" ? data.sessionID : undefined;

    switch (ev.type) {
      case "session.execution.started": {
        if (!sid || this.runs.has(sid)) break;
        // A prompt was sent from OpenCode itself (TUI or another client):
        // observe the run so the final answer is still reported to Telegram
        // once the agent finishes and goes idle.
        const chats = this.opts.chatsForSession(sid).filter((c) => c.notify);
        if (chats.length === 0) break;
        const run = this.createRun(sid, true);
        this.runs.set(sid, run);
        void this.attachObservers(run, chats);
        break;
      }
      case "session.step.started": {
        const run = sid ? this.runs.get(sid) : undefined;
        if (run) {
          if (typeof data.agent === "string") run.agent = data.agent;
          const m = data.model as { providerID?: string; id?: string } | undefined;
          if (m?.providerID && m.id) run.model = `${m.providerID}/${m.id}`;
          run.dirty = true;
        }
        break;
      }
      case "session.text.delta": {
        const run = sid ? this.runs.get(sid) : undefined;
        if (run) {
          const ord = Number(data.ordinal ?? 0);
          run.textParts.set(ord, (run.textParts.get(ord) ?? "") + String(data.delta ?? ""));
          run.dirty = true;
        }
        break;
      }
      case "session.text.ended": {
        const run = sid ? this.runs.get(sid) : undefined;
        if (run) {
          const ord = Number(data.ordinal ?? 0);
          run.textParts.set(ord, String(data.text ?? ""));
          run.dirty = true;
        }
        break;
      }
      case "session.reasoning.delta": {
        const run = sid ? this.runs.get(sid) : undefined;
        if (run) {
          const ord = Number(data.ordinal ?? 0);
          run.reasoningParts.set(
            ord,
            (run.reasoningParts.get(ord) ?? "") + String(data.delta ?? ""),
          );
          run.dirty = true;
        }
        break;
      }
      case "session.tool.input.started": {
        const run = sid ? this.runs.get(sid) : undefined;
        if (run && typeof data.id === "string") {
          run.tools.set(data.id, {
            id: data.id,
            name: String(data.name ?? "tool"),
            status: "running",
          });
          if (!run.toolOrder.includes(data.id)) run.toolOrder.push(data.id);
          run.dirty = true;
        }
        break;
      }
      case "session.tool.called": {
        const run = sid ? this.runs.get(sid) : undefined;
        if (run && typeof data.id === "string") {
          const tool = run.tools.get(data.id);
          if (tool) tool.detail = summarizeInput(data.input);
          run.dirty = true;
        }
        break;
      }
      case "session.tool.success": {
        const run = sid ? this.runs.get(sid) : undefined;
        if (run && typeof data.id === "string") {
          const tool = run.tools.get(data.id);
          if (tool) tool.status = "done";
          run.dirty = true;
        }
        break;
      }
      case "session.tool.failed": {
        const run = sid ? this.runs.get(sid) : undefined;
        if (run && typeof data.id === "string") {
          const tool = run.tools.get(data.id);
          if (tool) {
            tool.status = "error";
            const err = data.error as { message?: string } | undefined;
            if (err?.message) tool.detail = oneLine(err.message, 100);
          }
          run.dirty = true;
        }
        break;
      }
      case "permission.asked": {
        void this.onPermission(data);
        break;
      }
      case "session.execution.succeeded": {
        if (sid) this.scheduleFinalize(sid, "✅ Completato", 400);
        break;
      }
      case "session.execution.interrupted": {
        if (sid) this.scheduleFinalize(sid, "⚠️ Interrotto", 200);
        break;
      }
      case "session.execution.failed": {
        const err = data.error as { message?: string } | undefined;
        const note = err?.message ? `❌ Errore: ${oneLine(err.message, 200)}` : "❌ Errore";
        if (sid) this.scheduleFinalize(sid, note, 400);
        break;
      }
      case "session.idle": {
        if (sid && this.runs.has(sid)) this.scheduleFinalize(sid, undefined, 1200);
        break;
      }
      case "session.deleted": {
        if (sid) {
          const run = this.runs.get(sid);
          if (run?.finalizeTimer) clearTimeout(run.finalizeTimer);
          this.runs.delete(sid);
        }
        break;
      }
      default:
        break;
    }
  }

  private scheduleFinalize(sessionID: string, note: string | undefined, delayMs: number): void {
    const run = this.runs.get(sessionID);
    if (!run || run.finished) return;
    if (run.finalizeTimer) clearTimeout(run.finalizeTimer);
    run.finalizeTimer = setTimeout(() => {
      void this.finalize(run, note);
    }, delayMs);
    run.finalizeTimer.unref?.();
  }

  private async finalize(run: Run, note?: string): Promise<void> {
    if (run.finished) return;
    run.finished = true;
    if (note && !run.finishNote) run.finishNote = note;
    try {
      await this.flush(run, true);
    } catch (err: unknown) {
      log.error("finalizzazione fallita:", (err as Error).message);
    }
    this.runs.delete(run.sessionID);
  }

  private async tick(): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.finished || !run.dirty) continue;
      run.dirty = false;
      try {
        await this.flush(run, false);
      } catch (err: unknown) {
        log.debug("flush intermedio fallito:", (err as Error).message);
      }
    }
  }

  private header(run: Run): string {
    const bits: string[] = [];
    if (run.agent) bits.push(`<b>${escapeHtml(run.agent)}</b>`);
    if (run.model) bits.push(`<code>${escapeHtml(run.model)}</code>`);
    return bits.length ? `🤖 ${bits.join(" · ")}` : "🤖 OpenCode";
  }

  private async flush(run: Run, final: boolean): Promise<void> {
    if (final) {
      await this.deliverFinal(run);
      return;
    }

    // Stay silent until the agent starts writing the answer: no message is sent
    // for tool activity or reasoning, so the chat is only pinged once, when the
    // actual textual reply begins.
    if (!hasVisibleText(run)) return;

    const html = this.renderStream(run);
    if (!html || html === run.lastRendered) return;
    run.lastRendered = html;
    for (const [chatId, messageId] of run.targets) {
      if (messageId !== undefined) {
        await this.edit(chatId, messageId, html);
      } else {
        // Silent: the live progress must not ping the chat. The notification is
        // fired by the final message sent in deliverFinal().
        const sentId = await this.send(chatId, html, true);
        if (sentId !== undefined) run.targets.set(chatId, sentId);
      }
    }
  }

  private async deliverFinal(run: Run): Promise<void> {
    const messages = this.renderFinalMessages(run);
    const sendAll = async (chatId: number): Promise<void> => {
      for (let i = 0; i < messages.length; i++) {
        // Only the first final message notifies; the rest stay silent to avoid
        // a burst of notifications for long answers.
        await this.send(chatId, messages[i]!, i > 0);
      }
    };
    if (run.targets.size === 0) {
      // Observers weren't attached yet (or every send failed): fall back to
      // delivering the final answer as fresh messages to the watching chats.
      if (!run.observed) return;
      const chats = this.opts.chatsForSession(run.sessionID).filter((c) => c.notify);
      for (const { chatId } of chats) {
        await sendAll(chatId);
      }
      return;
    }
    for (const [chatId, messageId] of run.targets) {
      if (messageId !== undefined) {
        // Drop the silently streamed message and repost the answer as a brand
        // new message, so Telegram actually fires a notification when the
        // output is complete and the bot is waiting for input again.
        await this.delete(chatId, messageId);
      }
      await sendAll(chatId);
    }
  }

  private renderStream(run: Run): string {
    const parts: string[] = [this.header(run)];
    const body = joinParts(run.textParts);
    if (body.trim().length > 0) {
      const t = tail(body, 3000);
      parts.push(`${t.truncated ? "⋮ (in corso)\n" : ""}${escapeHtml(t.text)}`);
    }
    const reasoning = joinParts(run.reasoningParts);
    if (reasoning.trim().length > 0) {
      const t = tail(reasoning, 400);
      parts.push(`<blockquote expandable>🧠 ${escapeHtml(t.text)}</blockquote>`);
    }
    if (body.trim().length === 0) {
      parts.push(
        anyToolRunning(run) ? "⚙️ <i>sto lavorando…</i>" : "<i>sto pensando…</i>",
      );
    }
    let html = parts.join("\n\n");
    if (html.length > 4000) html = html.slice(html.length - 4000);
    return html;
  }

  private renderFinalMessages(run: Run): string[] {
    const banners: Block[] = [
      {
        kind: "html",
        text: `${this.header(run)}${run.finishNote ? `\n<i>${escapeHtml(run.finishNote)}</i>` : ""}`,
      },
    ];
    const text = joinParts(run.textParts);
    const blocks: Block[] = parseBlocks(text);
    if (blocks.length === 0) {
      blocks.push({ kind: "html", text: "<i>(nessun output testuale)</i>" });
    }
    blocks.push({ kind: "html", text: WAITING_FOOTER });
    return packBlocks(blocks, banners);
  }

  private async onPermission(data: Record<string, any>): Promise<void> {
    const sessionID = String(data.sessionID ?? "");
    const requestID = String(data.id ?? "");
    if (!sessionID || !requestID) return;
    const token = `p${++this.permCounter}`;
    this.permissions.set(token, { sessionID, requestID });

    const action = String(data.action ?? "azione");
    const resources = Array.isArray(data.resources) ? data.resources.map(String) : [];
    const message = typeof data.message === "string" ? data.message : undefined;

    const lines = [
      "🔐 <b>Richiesta di permesso</b>",
      `Azione: <code>${escapeHtml(action)}</code>`,
    ];
    if (resources.length > 0) {
      lines.push(`Risorse: <code>${escapeHtml(resources.join(", "))}</code>`);
    }
    if (message) lines.push(escapeHtml(message));

    const keyboard = {
      inline_keyboard: [
        [
          { text: "✅ Consenti una volta", callback_data: `perm:${token}:once` },
          { text: "♾️ Consenti sempre", callback_data: `perm:${token}:always` },
        ],
        [{ text: "⛔ Rifiuta", callback_data: `perm:${token}:reject` }],
      ],
    };

    const targets = this.opts.chatsForSession(sessionID).map((c) => c.chatId);
    const recipients = targets.length > 0 ? targets : this.opts.allChats();
    for (const chatId of recipients) {
      try {
        await this.opts.api().sendMessage(chatId, lines.join("\n"), {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } catch (err: unknown) {
        log.error("invio richiesta permesso fallito:", (err as Error).message);
      }
    }
  }

  private async send(chatId: number, html: string, silent = false): Promise<number | undefined> {
    try {
      const msg = await this.opts.api().sendMessage(chatId, html, {
        parse_mode: "HTML",
        ...(silent ? { disable_notification: true } : {}),
      });
      return msg.message_id;
    } catch (err: unknown) {
      log.error("sendMessage fallito:", (err as Error).message);
      return undefined;
    }
  }

  private async delete(chatId: number, messageId: number): Promise<void> {
    try {
      await this.opts.api().deleteMessage(chatId, messageId);
    } catch (err: unknown) {
      log.debug("deleteMessage fallito:", (err as Error).message);
    }
  }

  private async edit(chatId: number, messageId: number, html: string): Promise<void> {
    try {
      await this.opts.api().editMessageText(chatId, messageId, html, {
        parse_mode: "HTML",
      });
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? "";
      if (/message is not modified/i.test(msg)) return;
      log.debug("editMessageText fallito:", msg);
    }
  }
}

function joinParts(parts: Map<number, string>): string {
  return [...parts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .join("");
}

/** True once the agent has produced some actual reply text to show. */
function hasVisibleText(run: Run): boolean {
  for (const part of run.textParts.values()) {
    if (part.trim().length > 0) return true;
  }
  return false;
}

/** True while at least one tool is still running. */
function anyToolRunning(run: Run): boolean {
  for (const tool of run.tools.values()) {
    if (tool.status === "running") return true;
  }
  return false;
}

function summarizeInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  if (typeof o.command === "string") return oneLine(o.command, 100);
  if (typeof o.filePath === "string") return oneLine(o.filePath, 100);
  if (typeof o.path === "string") return oneLine(o.path, 100);
  if (typeof o.file === "string") return oneLine(o.file, 100);
  if (typeof o.pattern === "string") return oneLine(o.pattern, 80);
  if (typeof o.query === "string") return oneLine(o.query, 100);
  if (typeof o.url === "string") return oneLine(o.url, 100);
  try {
    const s = JSON.stringify(o);
    return s && s !== "{}" ? oneLine(s, 100) : undefined;
  } catch {
    return undefined;
  }
}
