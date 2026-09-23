// ============================================================
//  IMPERIO CRM · El Worker (Cloudflare)
//  Tu CRM propio: sin mensualidades, tus datos son tuyos.
//
//  - POST /lead      : captura un lead (desde tu landing, formulario o agenda)
//  - GET  /lead/:id  : ficha completa de un lead (requiere tu clave)
//  - /torre          : Torre de Control — el panel visual (torre.ts)
//  - Avisos a tu correo cuando llega un lead o agenda (avisos.ts)
//
//  Las tablas de la base de datos se crean SOLAS la primera vez.
//  No hay que correr migraciones ni pegar SQL en ningún lado.
// ============================================================

import {
  json, texto, escapeHtml, upsertLead, getLeadContext, registrarEvento, ultimaCita, normalizarTelefono, paisTelefono,
  ESTADOS_VALIDOS, RANGO, VERSION, type Cita, type Env,
} from "./crm";
import { handleTorre, torreAuthorized } from "./torre";
import { enviarAviso, avisoActivo, suscribirEnLista, type TipoAviso } from "./avisos";

// ---------- Las tablas se crean solas (una vez por arranque) ----------
let tablasListas: Promise<void> | null = null;

async function crearTablas(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS leads (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        channel     TEXT NOT NULL,
        external_id TEXT,
        name        TEXT,
        phone       TEXT,
        email       TEXT,
        status      TEXT NOT NULL DEFAULT 'nuevo',
        source      TEXT,
        notes       TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (channel, external_id)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id    INTEGER NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        channel    TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (lead_id) REFERENCES leads(id)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id    INTEGER NOT NULL,
        type       TEXT NOT NULL,
        payload    TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (lead_id) REFERENCES leads(id)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS config (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_events_lead   ON events(lead_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_channel ON leads(channel, external_id)`),
  ]);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,x-torre-key",
        },
      });
    }

    try {
      // Primera vez que arranca: crea sus tablas. Si algo falla, reintenta en la próxima visita.
      if (!tablasListas) tablasListas = crearTablas(env);
      try {
        await tablasListas;
      } catch (e) {
        tablasListas = null;
        throw e;
      }

      if (pathname === "/" && request.method === "GET") {
        return new Response(paginaInicio(env), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/health") {
        return json({ ok: true, service: "imperio-crm", version: VERSION, time: new Date().toISOString() });
      }

      // ---- Torre de Control (el panel visual) ----
      if (pathname === "/torre" || pathname.startsWith("/torre/")) {
        return await handleTorre(request, env, pathname);
      }

      // ---- Captura de leads ----
      if (pathname === "/lead" && request.method === "POST") {
        return await handleLeadCapture(request, env, ctx);
      }
      const leadMatch = pathname.match(/^\/lead\/(\d+)$/);
      if (leadMatch && request.method === "GET") {
        if (!(await torreAuthorized(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
        return await handleGetLead(Number(leadMatch[1]), env);
      }

      return json({ ok: false, error: "not_found" }, 404);
    } catch (err) {
      console.error("Worker error:", err);
      return json({ ok: false, error: "internal_error" }, 500);
    }
  },
};

// ---------- POST /lead : captura desde tu landing ----------
// Además de nombre / correo / WhatsApp / origen, acepta (todo opcional):
//   status  : a qué etapa pasa ("calificado", "agendo"...). Solo SUBE en el embudo.
//   answers : { "pregunta": "respuesta" } de tu formulario → quedan en su ficha y en tu aviso.
//   cita    : fecha de la cita en ISO (la que te da cal.com al agendar) → se muestra en TU hora.
async function handleLeadCapture(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const channel = texto(body.channel, 40) ?? "web";
  const email = texto(body.email)?.toLowerCase() ?? null;
  // El WhatsApp se guarda con indicativo (+57...) cuando se puede deducir; si no, tal cual.
  const phoneRaw = texto(body.phone, 40);
  const phone = normalizarTelefono(phoneRaw, paisTelefono(env)) ?? phoneRaw;
  const externalId = texto(body.external_id) ?? email ?? phone;
  if (!externalId) return json({ ok: false, error: "missing_identifier" }, 400);

  const previo = await env.DB.prepare("SELECT id, status FROM leads WHERE channel = ? AND external_id = ?")
    .bind(channel, externalId)
    .first<{ id: number; status: string }>();
  const lead = await upsertLead(env, {
    channel,
    externalId,
    name: texto(body.name, 120),
    source: texto(body.source),
    phone,
    email,
  });

  // Estado que manda el formulario: solo avanza (un comprador no vuelve a "nuevo").
  const pedido = texto(body.status, 20);
  if (pedido && pedido !== "baja" && ESTADOS_VALIDOS.includes(pedido)) {
    const sube = lead.status === "baja" || (RANGO[pedido] ?? 0) > (RANGO[lead.status] ?? 0);
    if (sube) {
      await env.DB.prepare("UPDATE leads SET status = ? WHERE id = ?").bind(pedido, lead.id).run();
      await registrarEvento(env, lead.id, `estado: ${pedido}`);
    }
  }

  // Respuestas del formulario: el historial completo queda como evento.
  const respuestas = limpiarRespuestas(body.answers);
  if (respuestas) await registrarEvento(env, lead.id, "respuestas", respuestas);

  // La cita: con la fecha exacta (ISO) para mostrarla en TU hora, no en la del lead.
  const cita = leerCita(body.cita);
  let citaNueva = false;
  if (cita) {
    const antes = await ultimaCita(env, lead.id);
    citaNueva = JSON.stringify(antes) !== JSON.stringify(cita);
    if (citaNueva) await registrarEvento(env, lead.id, "cita", cita);
  }

  // Avisos en segundo plano: no retrasan ni rompen la captura.
  // Agendó (o cambió la fecha) → "Agendó". Si no, y es la primera vez que llega → "Nuevo lead".
  let aviso: TipoAviso | null = null;
  if (pedido === "agendo" && (previo?.status !== "agendo" || citaNueva)) aviso = "agendo";
  else if (!previo) aviso = "nuevo";
  const torreUrl = new URL(request.url).origin + "/torre";
  if (aviso && avisoActivo(env, aviso)) {
    ctx.waitUntil(enviarAviso(env, lead.id, aviso, torreUrl).catch((e) => console.error("Aviso:", e)));
  }
  if (email) ctx.waitUntil(suscribirEnLista(env, email));

  return json({ ok: true, lead_id: lead.id });
}

// { "pregunta": "respuesta" } → textos limpios (las listas se unen con comas).
function limpiarRespuestas(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 40)) {
    const clave = texto(k, 120);
    const valor = texto(Array.isArray(val) ? val.join(", ") : val, 1000);
    if (clave && valor) out[clave] = valor;
  }
  return Object.keys(out).length ? out : null;
}

// La fecha de la cita: ISO → exacta; cualquier otro texto → se guarda tal cual.
function leerCita(v: unknown): Cita | null {
  const s = texto(v, 120);
  if (!s) return null;
  const d = new Date(/^\d{10,13}$/.test(s) ? Number(s) : s);
  const t = d.getTime();
  if (Number.isFinite(t) && d.getUTCFullYear() >= 2020 && d.getUTCFullYear() <= 2100 && /\d{4}-\d{2}-\d{2}|^\d{10,13}$/.test(s)) {
    return { inicio: d.toISOString() };
  }
  return { texto: s };
}

// ---------- GET /lead/:id : ficha completa (requiere tu clave) ----------
async function handleGetLead(id: number, env: Env): Promise<Response> {
  const ctx = await getLeadContext(env, id);
  if (!ctx) return json({ ok: false, error: "not_found" }, 404);
  return json({ ok: true, ...ctx });
}

// ---------- GET / : página de bienvenida ----------
function paginaInicio(env: Env): string {
  const negocio = escapeHtml(env.BUSINESS_NAME || "Mi Negocio");
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Imperio CRM · ${negocio}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090a;color:#f4f2ee;font-family:system-ui,sans-serif;padding:20px;box-sizing:border-box;}
  .card{max-width:460px;text-align:center;}
  .ok{font-size:44px;margin-bottom:6px;}
  h1{font-size:22px;margin:0 0 6px;}
  p{color:#8f8d88;font-size:14.5px;line-height:1.6;margin:0 0 22px;}
  a.btn{display:inline-block;padding:13px 26px;border-radius:999px;background:linear-gradient(180deg,#f6edd6,#cdb68c 60%,#b89b64);color:#0b0b0c;font-weight:700;text-decoration:none;font-size:15px;}
  .foot{margin-top:26px;font-size:11.5px;color:#5c5a55;}
  code{background:rgba(255,255,255,0.07);padding:2px 7px;border-radius:6px;font-size:12px;color:#cdb68c;}
</style>
</head>
<body>
  <div class="card">
    <div class="ok">✅</div>
    <h1>Tu Imperio CRM está vivo</h1>
    <p>${negocio} ya tiene CRM propio. Los leads que capture tu landing con <code>POST /lead</code> aparecen en tu Torre de Control.</p>
    <a class="btn" href="/torre">Abrir la Torre de Control →</a>
    <div class="foot">Imperio CRM · hecho con IA · Nómadas Millonarios</div>
  </div>
</body>
</html>`;
}
