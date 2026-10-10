// Plugin OpenCode: avvia automaticamente il bot Telegram insieme a OpenCode.
//
// Installazione: copia questo file nella cartella dei plugin globali di OpenCode.
//   Linux / macOS:  ~/.config/opencode/plugins/telegram-bot.ts
//   Windows:        %USERPROFILE%\.config\opencode\plugins\telegram-bot.ts
//
// Il bot viene avviato una sola volta, come processo indipendente, e si arresta
// da solo quando il servizio OpenCode non è più raggiungibile (watchdog).
//
// Per modificare il percorso del bot, imposta la variabile d'ambiente
// OPENCODE_TELEGRAM_BOT_DIR prima di avviare OpenCode.

import { Plugin } from "@opencode/plugin"
import { spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const BOT_DIR =
  process.env.OPENCODE_TELEGRAM_BOT_DIR ??
  path.join(homedir(), "opencode-telegram-bot")
const ENTRY = path.join(BOT_DIR, "dist", "index.js")
const DATA_DIR = path.join(BOT_DIR, "data")
const PID_FILE = path.join(DATA_DIR, "bot.pid")
const LOG_FILE = path.join(DATA_DIR, "bot.log")
const ENV_FILE = path.join(BOT_DIR, ".env")
const TAG = "[telegram-bot]"

function log(message: string): void {
  console.log(`${TAG} ${message}`)
}

function isConfigured(): boolean {
  try {
    const env = readFileSync(ENV_FILE, "utf8")
    return env.split(/\r?\n/).some((line) => /^[ \t]*TELEGRAM_BOT_TOKEN[ \t]*=[ \t]*\S+/.test(line))
  } catch {
    return false
  }
}

function readPid(): number | undefined {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim())
    return Number.isFinite(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isRunning(): boolean {
  const pid = readPid()
  return pid !== undefined && isAlive(pid)
}

function startBot(): void {
  if (!existsSync(ENTRY)) {
    log(`manca ${ENTRY}. Esegui "npm run build" in ${BOT_DIR}.`)
    return
  }
  mkdirSync(DATA_DIR, { recursive: true })
  const out = openSync(LOG_FILE, "a")
  const child = spawn("node", [ENTRY], {
    cwd: BOT_DIR,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    env: process.env,
  })
  child.unref()
  if (child.pid) {
    writeFileSync(PID_FILE, String(child.pid), "utf8")
    log(`bot avviato (pid ${child.pid})`)
  } else {
    log("avvio del bot fallito")
  }
}

export default Plugin.define({
  id: "opencode-telegram-bot",
  setup() {
    try {
      if (isRunning()) {
        log("bot già in esecuzione")
        return
      }
      if (!isConfigured()) {
        log("TELEGRAM_BOT_TOKEN non impostato in .env, salto l'avvio")
        return
      }
      startBot()
    } catch (err) {
      log(`errore: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
})

// Rimuove il pidfile residuo quando il plugin viene scaricato.
process.on("exit", () => {
  try {
    if (!isRunning()) rmSync(PID_FILE, { force: true })
  } catch {
    /* ignore */
  }
})
