import fs from "node:fs";
import { Bot, InlineKeyboard, type Context, type Filter } from "grammy";
import type { ModelInfo, OpenCodeClient, SessionInfo } from "@opencode/client";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { shortSessionId, escapeHtml, oneLine, relativeTime, truncate } from "./format.js";
import { StateStore, type ModelRef } from "./state.js";
import { SessionEngine } from "./runs.js";

const log = createLogger("bot");

const NO_PREVIEW = { link_preview_options: { is_disabled: true } } as const;

interface ChatCache {
  sessions?: string[];
  models?: ModelRef[];
  agents?: string[];
}

export interface BotDeps {
  client: OpenCodeClient;
  state: StateStore;
  engine: SessionEngine;
}

export function createBot(deps: BotDeps): Bot {
  const { client, state, engine } = deps;
  const bot = new Bot(config.botToken);
  const caches = new Map<number, ChatCache>();

  const cacheOf = (chatId: number): ChatCache => {
    let c = caches.get(chatId);
    if (!c) {
      c = {};
      caches.set(chatId, c);
    }
    return c;
  };

  function safe<T extends Context>(
    fn: (ctx: T) => Promise<void>,
  ): (ctx: T) => Promise<void> {
    return async (ctx: T) => {
      try {
        await fn(ctx);
      } catch (err: unknown) {
        const msg = (err as Error)?.message ?? String(err);
        log.error("handler error:", msg);
        try {
          await ctx.reply(`⚠️ Errore: ${escapeHtml(oneLine(msg, 300))}`, {
            parse_mode: "HTML",
          });
        } catch {
          /* ignore */
        }
      }
    };
  }

  // ---- access control -------------------------------------------------------

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (id !== undefined && config.allowedUserIds.has(id)) return next();
    if (config.allowUnsafe) return next();
    if (id !== undefined) {
      await ctx
        .reply(
          `⛔ Non sei autorizzato.\nIl tuo user ID Telegram è: <code>${id}</code>\n` +
            "Aggiungilo a TELEGRAM_ALLOWED_USER_IDS nel file .env e riavvia il bot.",
          { parse_mode: "HTML" },
        )
        .catch(() => undefined);
    }
  });

  // ---- helpers --------------------------------------------------------------

  function workdirFor(chatId: number): string {
    return state.get(chatId).workdir ?? config.defaultWorkdir;
  }

  async function locationFor(chatId: number): Promise<{ directory: string }> {
    return { directory: workdirFor(chatId) };
  }

  async function requireSession(ctx: Context, chatId: number): Promise<SessionInfo | undefined> {
    const st = state.get(chatId);
    if (!st.sessionID) {
      await ctx.reply(
        "Nessuna sessione attiva. Usa /new per crearne una o /sessions per selezionarne una.",
      );
      return undefined;
    }
    try {
      return await client.session.get({ sessionID: st.sessionID });
    } catch (err: unknown) {
      state.patch(chatId, { sessionID: undefined });
      await ctx.reply(
        `La sessione attiva non è più disponibile (${escapeHtml(oneLine((err as Error).message, 120))}). Usa /new o /sessions.`,
        { parse_mode: "HTML" },
      );
      return undefined;
    }
  }

  function sessionLine(s: SessionInfo, index: number, activeId?: string): string {
    const mark = s.id === activeId ? "▶️ " : "";
    const title = s.title?.trim() || "(senza titolo)";
    const model = s.model ? `${s.model.providerID}/${s.model.id}` : "—";
    const dir = s.location?.directory ?? "";
    return (
      `${mark}<b>${index + 1}.</b> ${escapeHtml(truncate(title, 60))}\n` +
      `     <code>${escapeHtml(dir)}</code>\n` +
      `     ${escapeHtml(model)} · ${relativeTime(s.time.updated)}`
    );
  }

  async function sendSessionList(ctx: Context, chatId: number): Promise<void> {
    const res = await client.session.list({ limit: 30, order: "desc" });
    const roots = res.data.filter((s) => !s.parentID).slice(0, 10);
    cacheOf(chatId).sessions = roots.map((s) => s.id);
    if (roots.length === 0) {
      await ctx.reply("Nessuna sessione trovata. Usa /new per crearne una.");
      return;
    }
    const active = state.get(chatId).sessionID;
    const text = ["📂 <b>Sessioni recenti</b>", roots.map((s, i) => sessionLine(s, i, active)).join("\n")].join(
      "\n\n",
    );
    const kb = new InlineKeyboard();
    roots.forEach((s, i) => {
      const label = `${i + 1}. ${truncate(s.title?.trim() || "senza titolo", 24)}`;
      kb.text(label, `s:${i}`).row();
    });
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb, ...NO_PREVIEW });
  }

  async function switchModel(
    ctx: Context,
    chatId: number,
    model: ModelRef,
  ): Promise<void> {
    const session = await requireSession(ctx, chatId);
    if (!session) return;
    await client.session.switchModel({ sessionID: session.id, model });
    state.patch(chatId, { preferredModel: model });
    await ctx.reply(
      `✅ Modello impostato: <code>${escapeHtml(model.providerID)}/${escapeHtml(model.id)}</code>`,
      { parse_mode: "HTML" },
    );
  }

  // ---- commands -------------------------------------------------------------

  bot.command(["start", "help"], safe(async (ctx) => {
    const chatId = ctx.chat.id;
    const st = state.get(chatId);
    const lines = [
      "🤖 <b>OpenCode Telegram Bot</b>",
      "",
      "Controllo delle sessioni OpenCode da Telegram.",
      "",
      "<b>Sessioni</b>",
      "/sessions — elenca e seleziona le sessioni",
      "/new [titolo] — crea una nuova sessione",
      "/current — sessione attiva",
      "/dir [percorso] — mostra/imposta la cartella di lavoro",
      "",
      "<b>Esecuzione</b>",
      "Invia un messaggio di testo → prompt alla sessione attiva",
      "/stop — interrompe l'esecuzione in corso",
      "/shell &lt;comando&gt; — esegue un comando shell nella cartella di lavoro",
      "",
      "<b>Configurazione</b>",
      "/model [provider/modello] — elenca o imposta il modello",
      "/agent [nome] — elenca o imposta l'agente",
      "/notify [on|off] — notifiche in tempo reale",
      "/id — mostra il tuo user ID",
      "",
      st.sessionID
        ? `Sessione attiva: <code>${shortSessionId(st.sessionID)}</code>`
        : "Nessuna sessione attiva.",
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", ...NO_PREVIEW });
  }));

  bot.command("id", safe(async (ctx) => {
    await ctx.reply(`Il tuo user ID è: <code>${ctx.from?.id}</code>`, {
      parse_mode: "HTML",
    });
  }));

  bot.command("sessions", safe(async (ctx) => {
    await sendSessionList(ctx, ctx.chat.id);
  }));

  bot.command("new", safe(async (ctx) => {
    const chatId = ctx.chat.id;
    const title = ctx.match?.toString().trim() || undefined;
    const st = state.get(chatId);
    const directory = workdirFor(chatId);
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch (err: unknown) {
      await ctx.reply(
        `❌ Impossibile usare la cartella <code>${escapeHtml(directory)}</code>: ${escapeHtml(oneLine((err as Error).message, 160))}`,
        { parse_mode: "HTML" },
      );
      return;
    }
    const session = await client.session.create({
      title: title ?? undefined,
      agent: st.preferredAgent ?? undefined,
      model: st.preferredModel ?? undefined,
      location: { directory },
    });
    state.patch(chatId, { sessionID: session.id, workdir: directory });
    await ctx.reply(
      `🆕 Sessione creata.\n<b>${escapeHtml(session.title ?? "(senza titolo)")}</b>\n` +
        `<code>${escapeHtml(session.id)}</code>\n📁 <code>${escapeHtml(directory)}</code>`,
      { parse_mode: "HTML", ...NO_PREVIEW },
    );
  }));

  bot.command("use", safe(async (ctx) => {
    const chatId = ctx.chat.id;
    const arg = ctx.match?.toString().trim();
    if (!arg) {
      await ctx.reply("Uso: /use &lt;numero|session-id&gt;", { parse_mode: "HTML" });
      return;
    }
    let sessionID: string | undefined;
    if (/^\d+$/.test(arg)) {
      const idx = Number(arg) - 1;
      sessionID = cacheOf(chatId).sessions?.[idx];
      if (!sessionID) {
        await ctx.reply("Numero non valido. Esegui /sessions e riprova.");
        return;
      }
    } else {
      sessionID = arg;
    }
    const session = await client.session.get({ sessionID });
    state.patch(chatId, {
      sessionID: session.id,
      workdir: session.location?.directory ?? workdirFor(chatId),
    });
    await ctx.reply(
      `▶️ Sessione attiva: <b>${escapeHtml(session.title ?? "(senza titolo)")}</b>\n<code>${escapeHtml(session.id)}</code>`,
      { parse_mode: "HTML", ...NO_PREVIEW },
    );
  }));

  bot.command("current", safe(async (ctx) => {
    const chatId = ctx.chat.id;
    const session = await requireSession(ctx, chatId);
    if (!session) return;
    const lines = [
      "📌 <b>Sessione attiva</b>",
      `<b>${escapeHtml(session.title ?? "(senza titolo)")}</b>`,
      `<code>${escapeHtml(session.id)}</code>`,
      `📁 <code>${escapeHtml(session.location?.directory ?? "")}</code>`,
      `🤖 ${session.agent ? escapeHtml(session.agent) : "—"} · ${session.model ? escapeHtml(`${session.model.providerID}/${session.model.id}`) : "—"}`,
      `💵 $${session.cost.toFixed(4)} · aggiornata ${relativeTime(session.time.updated)}`,
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", ...NO_PREVIEW });
  }));

  bot.command("stop", safe(async (ctx) => {
    const chatId = ctx.chat.id;
    const session = await requireSession(ctx, chatId);
    if (!session) return;
    const res = await client.session.interrupt({ sessionID: session.id });
    await ctx.reply(res.interrupted ? "⛔ Interruzione inviata." : "ℹ️ Nessuna esecuzione attiva.");
  }));

  bot.command("dir", safe(async (ctx) => {
    const chatId = ctx.chat.id;
    const arg = ctx.match?.toString().trim();
    if (!arg) {
      await ctx.reply(`📁 Cartella di lavoro: <code>${escapeHtml(workdirFor(chatId))}</code>`, {
        parse_mode: "HTML",
      });
      return;
    }
    try {
      const stat = fs.statSync(arg);
      if (!stat.isDirectory()) throw new Error("non è una cartella");
    } catch (err: unknown) {
      await ctx.reply(`❌ Percorso non valido: ${escapeHtml(oneLine((err as Error).message, 160))}`, {
        parse_mode: "HTML",
      });
      return;
    }
    state.patch(chatId, { workdir: arg });
    await ctx.reply(`📁 Cartella di lavoro impostata: <code>${escapeHtml(arg)}</code>`, {
      parse_mode: "HTML",
    });
  }));

  bot.command("notify", safe(async (ctx) => {
    const chatId = ctx.chat.id;
    const arg = ctx.match?.toString().trim().toLowerCase();
    if (arg === "on" || arg === "off") {
      state.patch(chatId, { notify: arg === "on" });
    }
    const on = state.get(chatId).notify;
    await ctx.reply(`🔔 Notifiche: <b>${on ? "attive" : "disattivate"}</b>${arg ? "" : " (usa /notify on|off)"}`, {
      parse_mode: "HTML",
    });
  }));

  bot.command("model", safe(async (ctx) => {
    const chatId = ctx.chat.id;
    const arg = ctx.match?.toString().trim();
    if (arg) {
      const [providerID, ...rest] = arg.split("/");
      const id = rest.join("/");
      if (!providerID || !id) {
        await ctx.reply("Uso: /model &lt;provider/modello&gt; (oppure /model senza argomenti per l'elenco)", {
          parse_mode: "HTML",
        });
        return;
      }
      await switchModel(ctx, chatId, { providerID, id });
      return;
    }

    const models = await client.model.list({ location: await locationFor(chatId) });
    const enabled = models.data.filter((m: ModelInfo) => m.enabled);
    if (enabled.length === 0) {
      await ctx.reply("Nessun modello disponibile.");
      return;
    }
    const refs: ModelRef[] = enabled.slice(0, 40).map((m) => ({
      providerID: m.providerID,
      id: m.modelID,
    }));
    cacheOf(chatId).models = refs;
    const kb = new InlineKeyboard();
    refs.forEach((m, i) => {
      kb.text(truncate(`${m.providerID}/${m.id}`, 45), `model:${i}`).row();
    });
    await ctx.reply("🧠 <b>Modelli disponibili</b>\nSeleziona un modello:", {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  }));

  bot.command("agent", safe(async (ctx) => {
    const chatId = ctx.chat.id;
    const arg = ctx.match?.toString().trim();
    const session = await requireSession(ctx, chatId);
    if (!session) return;

    if (arg) {
      await client.session.switchAgent({ sessionID: session.id, agent: arg });
      state.patch(chatId, { preferredAgent: arg });
      await ctx.reply(`✅ Agente impostato: <code>${escapeHtml(arg)}</code>`, {
        parse_mode: "HTML",
      });
      return;
    }

    const agents = await client.agent.list({ location: await locationFor(chatId) });
    const usable = agents.data.filter((a) => a.mode !== "subagent" && !a.hidden);
    if (usable.length === 0) {
      await ctx.reply("Nessun agente disponibile.");
      return;
    }
    cacheOf(chatId).agents = usable.map((a) => a.id);
    const kb = new InlineKeyboard();
    usable.forEach((a, i) => {
      kb.text(truncate(`${a.id} (${a.mode})`, 45), `agent:${i}`).row();
    });
    await ctx.reply(
      `🧩 <b>Agenti disponibili</b>${session.agent ? `\nAttuale: <code>${escapeHtml(session.agent)}</code>` : ""}`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  }));

  bot.command("shell", safe(async (ctx) => {
    const chatId = ctx.chat.id;
    const command = ctx.match?.toString().trim();
    if (!command) {
      await ctx.reply("Uso: /shell &lt;comando&gt;", { parse_mode: "HTML" });
      return;
    }
    const directory = workdirFor(chatId);
    const created = await client.shell.create({
      location: { directory },
      command,
      cwd: directory,
      timeout: 120_000,
    });
    const id = created.data.id;
    let info = created.data;
    const deadline = Date.now() + 120_000;
    while (info.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      info = (await client.shell.get({ id, location: { directory } })).data;
    }
    const out = await client.shell.output({ id, location: { directory } });
    const output = out.data.output ?? "";
    const statusIcon = info.status === "exited" && info.exit === 0 ? "✅" : "⚠️";
    const header = `${statusIcon} <code>${escapeHtml(oneLine(command, 120))}</code> — ${info.status}${info.exit !== undefined ? ` (exit ${info.exit})` : ""}`;
    const body = output.trim().length > 0 ? `<pre>${escapeHtml(truncate(output, 3500))}</pre>` : "<i>(nessun output)</i>";
    await ctx.reply(`${header}\n${body}`, { parse_mode: "HTML", ...NO_PREVIEW });
  }));

  // ---- free text -> prompt ---------------------------------------------------

  bot.on("message:text", safe(async (ctx: Filter<Context, "message:text">) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    if (text.startsWith("/")) {
      await ctx.reply("Comando sconosciuto. Usa /help.");
      return;
    }
    const st = state.get(chatId);
    if (!st.sessionID) {
      await ctx.reply("Nessuna sessione attiva. Usa /new per crearne una o /sessions per selezionarne una.");
      return;
    }
    const sessionID = st.sessionID;
    await engine.begin(sessionID, chatId);
    try {
      await client.session.prompt({ sessionID, text });
    } catch (err: unknown) {
      engine.abort(sessionID);
      const msg = escapeHtml(oneLine((err as Error).message, 300));
      await ctx.reply(`❌ ${msg}`, { parse_mode: "HTML" });
    }
  }));

  // ---- inline callbacks ------------------------------------------------------

  bot.callbackQuery(/^s:(\d+)$/, safe(async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const idx = Number(ctx.match![1]);
    const sessionID = cacheOf(chatId).sessions?.[idx];
    if (!sessionID) {
      await ctx.reply("Sessione non più in cache. Esegui /sessions.");
      return;
    }
    const session = await client.session.get({ sessionID });
    state.patch(chatId, {
      sessionID: session.id,
      workdir: session.location?.directory ?? workdirFor(chatId),
    });
    await ctx.editMessageText(
      `▶️ Sessione attiva: <b>${escapeHtml(session.title ?? "(senza titolo)")}</b>\n<code>${escapeHtml(session.id)}</code>`,
      { parse_mode: "HTML" },
    ).catch(() => undefined);
  }));

  bot.callbackQuery(/^model:(\d+)$/, safe(async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const idx = Number(ctx.match![1]);
    const model = cacheOf(chatId).models?.[idx];
    if (!model) {
      await ctx.reply("Elenco scaduto. Esegui di nuovo /model.");
      return;
    }
    const st = state.get(chatId);
    if (st.sessionID) {
      await client.session.switchModel({ sessionID: st.sessionID, model });
    }
    state.patch(chatId, { preferredModel: model });
    await ctx.editMessageText(
      `✅ Modello: <code>${escapeHtml(model.providerID)}/${escapeHtml(model.id)}</code>`,
      { parse_mode: "HTML" },
    ).catch(() => undefined);
  }));

  bot.callbackQuery(/^agent:(\d+)$/, safe(async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const idx = Number(ctx.match![1]);
    const agent = cacheOf(chatId).agents?.[idx];
    if (!agent) {
      await ctx.reply("Elenco scaduto. Esegui di nuovo /agent.");
      return;
    }
    const st = state.get(chatId);
    if (st.sessionID) {
      await client.session.switchAgent({ sessionID: st.sessionID, agent });
    }
    state.patch(chatId, { preferredAgent: agent });
    await ctx.editMessageText(`✅ Agente: <code>${escapeHtml(agent)}</code>`, {
      parse_mode: "HTML",
    }).catch(() => undefined);
  }));

  bot.callbackQuery(/^perm:(p\d+):(once|always|reject)$/, safe(async (ctx) => {
    const token = ctx.match![1];
    const decision = ctx.match![2] as "once" | "always" | "reject";
    const pending = engine.resolvePermission(token);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Richiesta non più valida.", show_alert: true });
      return;
    }
    await client.permission.reply({
      sessionID: pending.sessionID,
      requestID: pending.requestID,
      decision,
    });
    const label = decision === "reject" ? "⛔ Rifiutato" : decision === "always" ? "♾️ Consentito sempre" : "✅ Consentito";
    await ctx.answerCallbackQuery({ text: label });
    await ctx.editMessageText(`${label}`, { parse_mode: "HTML" }).catch(() => undefined);
  }));

  bot.catch((err) => {
    const e = err.error;
    log.error("bot error:", e instanceof Error ? e.message : String(e));
  });

  return bot;
}
