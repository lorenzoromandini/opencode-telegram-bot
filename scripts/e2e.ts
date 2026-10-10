import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenCode, type V2Event } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { SessionEngine } from "../src/runs.js";

const endpoint = await Service.ensure();
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });

const dir = path.join(os.tmpdir(), "opencode-telegram-bot-e2e");
fs.mkdirSync(dir, { recursive: true });

console.log("creo sessione di test in", dir);
const session = await client.session.create({
  title: "e2e telegram-bot smoke",
  model: { providerID: "deepseek", id: "deepseek-flash" },
  location: { directory: dir },
});
console.log("sessione:", session.id);

const captured: string[] = [];
const fakeApi = {
  sendMessage: async (_chat: number, html: string) => {
    captured.push("SEND " + html);
    console.log("\n[SEND]\n" + html);
    return { message_id: captured.length };
  },
  editMessageText: async (_chat: number, id: number, html: string) => {
    captured.push("EDIT " + html);
    console.log("\n[EDIT " + id + "]\n" + html);
    return true as unknown;
  },
} as unknown as import("grammy").Api;

const engine = new SessionEngine({
  api: () => fakeApi,
  intervalMs: 800,
  chatsForSession: () => [{ chatId: 1, notify: true }],
  allChats: () => [1],
});

const controller = new AbortController();
void (async () => {
  try {
    for await (const ev of client.event.subscribe({ signal: controller.signal })) {
      engine.onEvent(ev as V2Event);
    }
  } catch {
    /* aborted */
  }
})();

await engine.begin(session.id, 1);
console.log("invio prompt…");
await client.session.prompt({
  sessionID: session.id,
  text:
    "Rispondi in modo brevissimo (max 3 righe) con 3 punti elenco e poi un blocco di codice ```js con una funzione somma(a,b). Non usare altri strumenti.",
});

const deadline = Date.now() + 60_000;
while (engine.hasRun(session.id) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 400));
}

console.log("\n=== run terminato ===");
console.log("messaggi catturati:", captured.length);

controller.abort();
engine.stop();
await client.session.remove({ sessionID: session.id });
console.log("sessione di test rimossa.");
process.exit(0);
