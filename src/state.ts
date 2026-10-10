import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("state");

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface ChatState {
  sessionID?: string;
  workdir?: string;
  notify: boolean;
  preferredModel?: ModelRef;
  preferredAgent?: string;
}

interface PersistedState {
  version: 1;
  chats: Record<string, ChatState>;
}

function defaults(): ChatState {
  return { notify: true };
}

export class StateStore {
  private chats = new Map<number, ChatState>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(config.stateFile, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      for (const [k, v] of Object.entries(parsed.chats ?? {})) {
        const id = Number(k);
        if (Number.isFinite(id)) this.chats.set(id, { ...defaults(), ...v });
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("impossibile leggere lo stato, riparto da zero:", (err as Error).message);
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 400);
    this.saveTimer.unref?.();
  }

  save(): void {
    const data: PersistedState = { version: 1, chats: {} };
    for (const [id, st] of this.chats) data.chats[String(id)] = st;
    try {
      fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
      const tmp = `${config.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, config.stateFile);
    } catch (err: unknown) {
      log.error("salvataggio stato fallito:", (err as Error).message);
    }
  }

  get(chatId: number): ChatState {
    let st = this.chats.get(chatId);
    if (!st) {
      st = defaults();
      this.chats.set(chatId, st);
    }
    return st;
  }

  patch(chatId: number, patch: Partial<ChatState>): ChatState {
    const next = { ...this.get(chatId), ...patch };
    this.chats.set(chatId, next);
    this.scheduleSave();
    return next;
  }

  /** Chats that currently have this session as their active one. */
  chatsForSession(sessionID: string): { chatId: number; notify: boolean }[] {
    const out: { chatId: number; notify: boolean }[] = [];
    for (const [chatId, st] of this.chats) {
      if (st.sessionID === sessionID) out.push({ chatId, notify: st.notify });
    }
    return out;
  }
}
