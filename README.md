# OpenCode Telegram Bot

Bot Telegram per **controllare e comandare le sessioni di [OpenCode](https://opencode.ai)**
direttamente da Telegram: elencare/creare sessioni, inviare prompt e vedere la risposta in
tempo reale, interrompere esecuzioni, cambiare modello o agente, approvare i permessi dei
tool ed eseguire comandi shell.

Il bot **non gestisce chiavi API**: si collega al server OpenCode già in esecuzione e usa la
configurazione e le credenziali di OpenCode. Funziona quindi con **qualsiasi provider**
(DeepSeek, Anthropic, OpenAI, i provider gratuiti di OpenCode, …) senza modifiche al bot.

---

## Requisiti

- **Node.js 20+** (testato su Node 24)
- **OpenCode 2** installato e con almeno un provider autenticato (`opencode auth login`)
- Un bot Telegram creato con [@BotFather](https://t.me/BotFather)

## Installazione

```bash
git clone https://github.com/lorenzoromandini/opencode-telegram-bot.git
cd opencode-telegram-bot
npm install
npm run setup      # crea .env e chiede il token del bot
```

`npm run setup` è il percorso consigliato: crea un `.env` **vuoto** a partire da
`.env.example` e ti chiede solo i dati necessari. In alternativa puoi copiare
`.env.example` in `.env` e compilarlo a mano.

## Configurazione

Il bot richiede **due soli valori**:

1. **Token del bot** — crea il bot con **@BotFather** (`/newbot`) e incolla il token in
   `TELEGRAM_BOT_TOKEN`.
2. **Il tuo user ID** — al primo avvio lascia `TELEGRAM_ALLOWED_USER_IDS` **vuoto**, scrivi
   un messaggio al bot e ti risponderà con il tuo ID. Incollalo in
   `TELEGRAM_ALLOWED_USER_IDS` e riavvia.

```dotenv
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_ALLOWED_USER_IDS=123456789
```

> Più utenti: separa gli ID con virgola. `ALLOW_UNSAFE=true` apre il bot a chiunque — **sconsigliato**.

Tutte le altre variabili (server OpenCode, cartella di lavoro, intervallo di aggiornamento,
livello di log) sono opzionali: vedi `.env.example`.

## Avvio

```bash
npm run dev     # sviluppo (ricarica automatica)
# oppure
npm run build
npm start       # produzione
```

All'avvio il bot si collega automaticamente al **servizio OpenCode in background** (lo stesso
usato dal TUI), quindi vede e controlla le tue sessioni reali. Per usare un server diverso,
imposta `OPENCODE_SERVER_URL`.

## Avvio automatico con OpenCode

Nella cartella [`plugin/`](plugin/) è incluso un **plugin OpenCode** che avvia il bot
automaticamente quando OpenCode è in esecuzione. Per installarlo, copia il file nella cartella
dei plugin globali di OpenCode:

```bash
# Linux / macOS
cp plugin/telegram-bot.ts ~/.config/opencode/plugins/telegram-bot.ts

# Windows (PowerShell)
Copy-Item plugin\telegram-bot.ts "$env:USERPROFILE\.config\opencode\plugins\telegram-bot.ts"
```

Il plugin si aspetta che il bot sia in `~/opencode-telegram-bot` (o nella cartella indicata
da `OPENCODE_TELEGRAM_BOT_DIR`). Comportamento:

- avvia il bot **una sola volta**, come processo indipendente, quando OpenCode è in esecuzione;
- **non avvia duplicati** se il bot è già attivo (controlla il pidfile `data/bot.pid`);
- **non fa nulla** finché `TELEGRAM_BOT_TOKEN` è vuoto nel `.env`;
- il bot **si arresta da solo** se il servizio OpenCode diventa irraggiungibile (watchdog).

Note:

- il plugin esegue `node dist/index.js`: dopo aver modificato i file in `src/`, esegui
  `npm run build` per aggiornare la versione usata dall'avvio automatico;
- i log del bot avviato automaticamente sono in `data/bot.log`;
- per lo sviluppo usa `npm run dev`: il plugin, trovando il bot già attivo, non ne avvia un secondo;
- per spostare il bot in un'altra cartella imposta `OPENCODE_TELEGRAM_BOT_DIR`.

## Comandi

| Comando | Descrizione |
| --- | --- |
| `/sessions` | Elenca le sessioni recenti e permette di selezionarne una |
| `/new [titolo]` | Crea una nuova sessione nella cartella di lavoro |
| `/use <n\|id>` | Attiva una sessione per numero o ID |
| `/current` | Mostra la sessione attiva (cartella, modello, agente, costo) |
| `/stop` | Interrompe l'esecuzione in corso |
| `/model [provider/modello]` | Elenca (con pulsanti) o imposta il modello |
| `/agent [nome]` | Elenca (con pulsanti) o imposta l'agente |
| `/shell <comando>` | Esegue un comando shell nella cartella di lavoro |
| `/dir [percorso]` | Mostra o imposta la cartella di lavoro |
| `/notify on\|off` | Attiva/disattiva le notifiche in tempo reale |
| `/id` | Mostra il tuo user ID |
| `/help` | Aiuto |

**Inviare un prompt**: con una sessione attiva, scrivi un normale messaggio di testo. La
risposta dell'agente appare in un messaggio che si **aggiorna in tempo reale** (testo, stato
dei tool, reasoning). Al termine, il messaggio viene completato e suddiviso se troppo lungo.

**Prompt avviati fuori da Telegram**: se la stessa sessione viene usata dalla TUI di OpenCode
(o da un altro client), il bot **osserva** comunque l'esecuzione. Invia un messaggio
"⏳ OpenCode sta elaborando…" che si aggiorna con il progresso e, quando l'agente ha finito e
torna in attesa di input, lo trasforma nella **risposta finale** chiudendo con
"⏸️ In attesa del tuo input": da lì puoi rispondere direttamente da Telegram. L'osservazione
vale solo per le sessioni selezionate (con `/use`) e con le notifiche attive (`/notify on`).

**Permessi**: quando OpenCode chiede l'autorizzazione per un tool, ricevi un messaggio con i
pulsanti **Consenti una volta / Consenti sempre / Rifiuta**.

## Come funziona

```
Telegram  <->  grammY Bot  <->  @opencode/client  <->  servizio OpenCode (HTTP)
                                     ^
                          stream eventi (/api/event)
```

- `src/opencode.ts` — scopre il servizio OpenCode (`Service.ensure`) e crea il client tipizzato;
  sottoscrive lo stream eventi con riconnessione automatica.
- `src/runs.ts` — "motore": trasforma gli eventi di una sessione (delta di testo, reasoning,
  tool, permessi) in un messaggio Telegram aggiornato progressivamente. Segue anche le
  esecuzioni avviate fuori da Telegram (TUI/altri client) per riportarne il messaggio finale.
- `src/bot.ts` — comandi, pulsanti inline e gestione dei messaggi.
- `src/state.ts` — stato per chat (sessione attiva, cartella, modello/agente preferiti),
  persistito in `data/state.json`.
- `plugin/telegram-bot.ts` — plugin OpenCode che avvia il bot automaticamente (opzionale).

## Modelli e provider

Il bot elenca i modelli che OpenCode considera **abilitati** (dal comando `/model`). Per
aggiungere un provider usa OpenCode:

```bash
opencode auth login      # aggiungi un provider
opencode models          # verifica i modelli disponibili
```

Non serve toccare il bot.

## Sicurezza

Il bot può **eseguire comandi shell e comandare OpenCode** sulla tua macchina. Tienilo
protetto:

- mantieni `TELEGRAM_ALLOWED_USER_IDS` con solo i tuoi ID;
- non usare `ALLOW_UNSAFE=true` in produzione;
- considera che `permission.asked` blocca l'esecuzione finché non rispondi da Telegram.

**Dati sensibili**: `.env`, `data/` (`state.json`, `bot.pid`, log) e `node_modules/`/`dist/`
sono esclusi dal versionamento tramite `.gitignore`. Nella repo viene pubblicato solo
`.env.example` con i campi **vuoti**: nessun token o user ID viene mai caricato.

## Sviluppo

```bash
npm run typecheck   # controllo tipi
npm run smoke       # test formattazione + connessione allo stream eventi
npm run e2e         # prova reale: crea una sessione, invia un prompt, poi la elimina
```

## Risoluzione problemi

- **"TELEGRAM_BOT_TOKEN mancante"** — esegui `npm run setup` o compila `.env`.
- **Il bot non vede le sessioni** — verifica `opencode service status` e poi
  `opencode api get /api/info`.
- **"Location not found"** — la cartella di lavoro della sessione non esiste; usa `/dir` per
  impostarne una valida (le nuove sessioni creano la cartella se manca).
- **Nessuna risposta in chat** — controlla che lo stream eventi sia attivo (log a livello
  `debug`) e che la sessione selezionata sia quella giusta (`/current`).
- **Non ricevo la risposta finale dei prompt avviati dal TUI** — assicurati di avere la
  sessione selezionata (`/use`) e le notifiche attive (`/notify on`).

## Licenza

[MIT](LICENSE) © 2026 Lorenzo Romandini
