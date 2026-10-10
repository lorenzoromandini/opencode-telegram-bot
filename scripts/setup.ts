// Wizard di primo avvio: crea .env dal template .env.example chiedendo solo i
// dati necessari (token del bot e, facoltativamente, l'user ID autorizzato).
//
// Uso:  npm run setup

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");

const TOKEN_KEY = "TELEGRAM_BOT_TOKEN";
const IDS_KEY = "TELEGRAM_ALLOWED_USER_IDS";

const FALLBACK_TEMPLATE = [
  "# Token del bot Telegram (da BotFather). OBBLIGATORIO.",
  `${TOKEN_KEY}=`,
  "",
  "# ID utente Telegram autorizzati, separati da virgola o spazio.",
  `# ${IDS_KEY}=`,
  "",
  "ALLOW_UNSAFE=false",
  "",
  "STREAM_EDIT_INTERVAL_MS=1500",
  "LOG_LEVEL=info",
  "",
].join("\n");

function readTemplate(): string {
  try {
    return fs.readFileSync(examplePath, "utf8");
  } catch {
    return FALLBACK_TEMPLATE;
  }
}

function setKey(text: string, key: string, value: string): string {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(text)) return text.replace(re, line);
  return `${text.trimEnd()}\n${line}\n`;
}

/** Smaschera il commento davanti alla variabile, così la riga resta attiva. */
function uncommentKey(text: string, key: string): string {
  const re = new RegExp(`^[ \\t]*#[ \\t]*(${key}[ \\t]*=.*)$`, "m");
  return text.replace(re, "$1");
}

/**
 * Lettore di righe robusto: mette in coda le righe in arrivo, così funziona sia
 * in terminale interattivo sia con input reindirizzato (pipe/file).
 */
function createPrompt(): () => Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const queue: string[] = [];
  let waiting: ((line: string) => void) | undefined;
  let closed = false;

  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(line);
    } else {
      queue.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve("");
    }
  });

  return (prompt?: string) => {
    if (prompt) process.stdout.write(prompt);
    if (queue.length > 0) return Promise.resolve(queue.shift()!);
    if (closed) return Promise.resolve("");
    return new Promise<string>((resolve) => {
      waiting = resolve;
    });
  };
}

async function main(): Promise<void> {
  const ask = createPrompt();

  console.log("\n=== OpenCode Telegram Bot — setup ===\n");

  if (fs.existsSync(envPath)) {
    const answer = (await ask(".env esiste già. Sovrascrivere? [s/N] ")).trim().toLowerCase();
    if (!["s", "si", "sì", "y", "yes"].includes(answer)) {
      console.log("Nessuna modifica. Uscita.");
      return;
    }
  }

  const token = (await ask("Token del bot Telegram (da @BotFather): ")).trim();
  if (!token) {
    console.error("\n× Token mancante: il bot non può partire senza TELEGRAM_BOT_TOKEN.");
    process.exitCode = 1;
    return;
  }
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    console.warn("! Il token non ha il formato usuale (numeri:lettere). Continuo comunque.");
  }

  console.log(
    "\nUser ID autorizzato (lascia vuoto se non lo conosci ancora:" +
      "\nal primo avvio il bot risponderà con il tuo ID, poi lo incollerai).",
  );
  const ids = (await ask(`Valore per ${IDS_KEY} (es. 123456789): `)).trim();

  let env = readTemplate();
  env = uncommentKey(env, TOKEN_KEY);
  env = uncommentKey(env, IDS_KEY);
  env = setKey(env, TOKEN_KEY, token);
  env = setKey(env, IDS_KEY, ids);
  if (!env.endsWith("\n")) env += "\n";

  fs.writeFileSync(envPath, env, "utf8");
  console.log(`\n✓ Scritto ${envPath}`);

  console.log("\nProssimi passi:");
  console.log("  1. npm run build   (oppure npm run dev in sviluppo)");
  console.log("  2. Avvia il bot e scrivigli un messaggio su Telegram.");
  if (!ids) {
    console.log(
      "  3. Il bot ti risponderà con il tuo user ID: incollalo in" +
        `\n     ${IDS_KEY} dentro .env e riavvia.`,
    );
  } else {
    console.log("  3. Scrivi al bot su Telegram: sei già autorizzato.");
  }
  console.log("");
}

main().catch((err: unknown) => {
  console.error("Setup fallito:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
