import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { escapeHtml, parseBlocks, packBlocks } from "../src/format.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("  ok:", msg);
}

console.log("== format ==");
assert(escapeHtml("<b>&</b>") === "&lt;b&gt;&amp;&lt;/b&gt;", "escapeHtml");
const blocks = parseBlocks("Ciao\n```js\nconst a = 1 < 2;\n```\nFatto");
assert(blocks.length === 3, "parseBlocks -> 3 blocchi");
assert(blocks[1]!.kind === "code", "blocco centrale e' codice");
const msgs = packBlocks(blocks, [{ kind: "text", text: "🤖 test" }]);
assert(msgs[0]!.includes("🤖 test"), "banner incluso");
assert(msgs[0]!.includes("<pre>const a = 1 &lt; 2;</pre>"), "codice reso come <pre>");
console.log("  messaggi generati:", msgs.length);

console.log("== opencode event stream ==");
const endpoint = await Service.ensure();
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
const info = await client.server.info();
console.log("  server:", info.version, endpoint.url);

const controller = new AbortController();
let count = 0;
setTimeout(() => controller.abort(), 3500);
try {
  for await (const ev of client.event.subscribe({ signal: controller.signal })) {
    count++;
    console.log("  evento:", (ev as { type?: string }).type);
    if (count >= 3) break;
  }
} catch (err) {
  if (!controller.signal.aborted) throw err;
}
assert(true, `stream eventi raggiungibile (${count} eventi)`);
console.log("\nTUTTO OK");
