import fs from "node:fs";
import path from "node:path";
import type { Bot } from "grammy";
import type { OpenCodeClient } from "@opencode/client";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { connectOpenCode, startEventStream } from "./opencode.js";
import { StateStore } from "./state.js";
import { SessionEngine } from "./runs.js";
import { createBot } from "./bot.js";

const log = createLogger("main");

const PID_FILE = path.join(config.projectRoot, "data", "bot.pid");

function writePidFile(): void {
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
  } catch (err: unknown) {
    log.warn("impossibile scrivere il pidfile:", (err as Error).message);
  }
}

function removePidFile(): void {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    if (Number(raw) === process.pid) fs.rmSync(PID_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  writePidFile();
  process.once("exit", removePidFile);

  const { client, url } = await connectOpenCode();

  try {
    const info = await client.server.info();
    log.info(`connesso a OpenCode v${info.version} su ${url}`);
  } catch {
    log.warn("server.info() non disponibile, proseguo comunque");
  }

  const state = new StateStore();
  const abort = new AbortController();

  if (config.lockdown) {
    log.warn(
      "Nessun utente autorizzato. Il bot rifiuterà tutti e risponderà con il loro ID: " +
        "scrivi al bot per scoprire il tuo ID, aggiungilo a TELEGRAM_ALLOWED_USER_IDS e riavvia.",
    );
  }

  let bot: Bot;
  const engine = new SessionEngine({
    api: () => bot.api,
    intervalMs: config.streamEditIntervalMs,
    chatsForSession: (sessionID) => state.chatsForSession(sessionID),
    allChats: () => [...config.allowedUserIds],
  });

  bot = createBot({ client, state, engine });

  startEventStream(client, (event) => engine.onEvent(event), abort.signal, (connected) => {
    log.debug(connected ? "stream eventi collegato" : "stream eventi disconnesso");
  });

  // Stop the bot when the OpenCode service it connected to goes away.
  startWatchdog(client, () => void shutdown("servizio OpenCode non raggiungibile"));

  await registerCommandsMenu(bot);

  let stopping = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info(`arresto (${reason})…`);
    abort.abort();
    engine.stop();
    state.save();
    removePidFile();
    try {
      await bot.stop();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => log.error("unhandledRejection:", reason));

  await bot.start({
    onStart: (me) => log.info(`bot attivo come @${me.username}`),
  });
}

function startWatchdog(client: OpenCodeClient, onLost: () => void): void {
  const intervalMs = 15_000;
  const maxFailures = 4;
  let failures = 0;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    void client
      .server
      .info({ signal: AbortSignal.timeout(5_000) })
      .then(() => {
        failures = 0;
      })
      .catch(() => {
        failures++;
        if (failures >= maxFailures) {
          stopped = true;
          clearInterval(timer);
          log.warn("servizio OpenCode non raggiungibile, arresto il bot");
          onLost();
        }
      });
  }, intervalMs);
  timer.unref?.();
}

async function registerCommandsMenu(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands([
      { command: "sessions", description: "Elenca e seleziona le sessioni" },
      { command: "new", description: "Crea una nuova sessione" },
      { command: "current", description: "Mostra la sessione attiva" },
      { command: "stop", description: "Interrompe l'esecuzione in corso" },
      { command: "model", description: "Elenca/imposta il modello" },
      { command: "agent", description: "Elenca/imposta l'agente" },
      { command: "shell", description: "Esegue un comando shell" },
      { command: "dir", description: "Mostra/imposta la cartella di lavoro" },
      { command: "notify", description: "Attiva/disattiva le notifiche" },
      { command: "id", description: "Mostra il tuo user ID" },
      { command: "help", description: "Aiuto" },
    ]);
  } catch (err: unknown) {
    log.warn("setMyCommands fallito:", (err as Error).message);
  }
}

main().catch((err) => {
  log.error("avvio fallito:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
