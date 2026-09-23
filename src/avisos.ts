// ============================================================
//  IMPERIO CRM · Avisos a tu correo (por Brevo, plan gratis)
//
//  El correo que te manda tu agenda (cal.com, Calendly...) casi nunca
//  trae el WhatsApp del lead, y sin eso no puedes confirmarle la cita.
//  Aquí el CRM te escribe al instante con todo lo que necesitas:
//    - "Nuevo lead: Ana"           → alguien dejó sus datos
//    - "Agendó: Ana — lunes 3 pm"  → alguien agendó (la hora en TU zona)
//  Cada aviso trae nombre, WhatsApp, correo, de qué anuncio vino, sus
//  respuestas y un botón verde para escribirle por WhatsApp con el saludo
//  ya escrito. Si respondes el correo, le llega directo al lead.
//
//  Y si configuras BREVO_LISTA_ID, cada lead con correo entra a esa
//  lista (para tu secuencia de correos automática).
//
//  Nada de esto rompe la captura: si Brevo falla, el lead ya quedó
//  guardado, y en su ficha de la Torre queda anotado por qué no salió.
// ============================================================

import {
  escapeHtml, colorValido, haciaNegro, linkWhatsApp, normalizarTelefono, paisTelefono, zonaHoraria,
  ultimasRespuestas, ultimaCita, citaLegible, registrarEvento, type Env,
} from "./crm";

const BREVO = "https://api.brevo.com/v3";

export type TipoAviso = "nuevo" | "agendo";

// ¿Quieres este aviso? Se controla con la variable AVISOS ("nuevo,agendo" por defecto).
export function avisoActivo(env: Env, tipo: TipoAviso): boolean {
  const cfg = (env.AVISOS ?? "nuevo,agendo").toLowerCase();
  return cfg.split(/[\s,]+/).includes(tipo);
}

export const avisosConfigurados = (env: Env) => !!(env.BREVO_API_KEY && env.AVISO_EMAIL);

interface LeadAviso {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  source: string | null;
}

const primerNombre = (n: string | null) => (n || "").trim().split(/\s+/)[0] || "";

// ---------- Enviar el aviso de un lead ----------
export async function enviarAviso(
  env: Env,
  leadId: number,
  tipo: TipoAviso,
  torreUrl: string
): Promise<{ ok: boolean; error?: string }> {
  if (!avisosConfigurados(env)) return { ok: false, error: "sin_configurar" };
  const lead = await env.DB.prepare("SELECT id, name, email, phone, status, source FROM leads WHERE id = ?")
    .bind(leadId)
    .first<LeadAviso>();
  if (!lead) return { ok: false, error: "no_existe" };

  const tz = zonaHoraria(env);
  const [respuestas, cita] = await Promise.all([ultimasRespuestas(env, leadId), ultimaCita(env, leadId)]);
  const citaTxt = tipo === "agendo" ? citaLegible(cita, tz) : null;
  const negocio = env.BUSINESS_NAME || "Mi Negocio";
  const quien = lead.name || lead.email || lead.phone || "un lead";

  const asunto = tipo === "agendo"
    ? `Agendó: ${quien}${citaTxt ? " — " + citaTxt : ""}`
    : `Nuevo lead: ${quien}`;
  const titulo = tipo === "agendo" ? "✅ AGENDÓ UNA CITA" : "🔔 NUEVO LEAD";
  const saludo = `Hola ${primerNombre(lead.name)}, te escribo de ${negocio}.`.replace("Hola ,", "Hola,");

  const cuerpo =
    (citaTxt ? `<div style="font-size:16px;margin:0 0 16px;">📅 <b>${esc(citaTxt)}</b>${cita?.inicio ? " (tu hora)" : ""}</div>` : "") +
    bloqueContacto(env, lead, saludo) +
    tablaRespuestas(respuestas, colorCorreo(env));

  const html = marco(env, titulo, cuerpo, torreUrl);
  const r = await brevo(env, "/smtp/email", {
    sender: { name: "Imperio CRM", email: env.AVISO_REMITENTE || env.AVISO_EMAIL },
    to: [{ email: env.AVISO_EMAIL }],
    ...(lead.email ? { replyTo: { email: lead.email, ...(lead.name ? { name: lead.name } : {}) } } : {}),
    subject: asunto,
    htmlContent: html,
  });
  // Queda en la historia del lead: así sabes si te llegó (o por qué no).
  await registrarEvento(env, leadId, "aviso_correo", { tipo, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
  return r;
}

// ---------- Meter al lead en tu lista de Brevo (secuencia de correos) ----------
// Idempotente: si ya existe lo actualiza, y Brevo solo dispara la automatización
// de "entró a la lista" la primera vez — no hay correos dobles.
export async function suscribirEnLista(env: Env, email: string | null): Promise<void> {
  const lista = Number(env.BREVO_LISTA_ID || 0);
  if (!env.BREVO_API_KEY || !lista || !email || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return;
  const r = await brevo(env, "/contacts", { email: email.toLowerCase(), listIds: [lista], updateEnabled: true });
  if (!r.ok) console.error("Brevo lista:", r.error);
}

async function brevo(env: Env, ruta: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(BREVO + ruta, {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY!, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return { ok: true };
    const detalle = (await r.text()).slice(0, 300);
    console.error("Brevo rechazó", ruta, r.status, detalle);
    return { ok: false, error: `Brevo ${r.status}: ${detalle}` };
  } catch (e) {
    console.error("Brevo no respondió", ruta, e);
    return { ok: false, error: "Brevo no respondió" };
  }
}

// ---------- El correo (HTML simple: se ve bien en Gmail, Outlook y el celular) ----------
const esc = (s: unknown) => escapeHtml(String(s ?? ""));

function bloqueContacto(env: Env, lead: LeadAviso, saludo: string): string {
  const e164 = normalizarTelefono(lead.phone, paisTelefono(env));
  const wa = linkWhatsApp(e164, saludo);
  const dudoso = lead.phone && !e164
    ? `<div style="color:#b45309;font-size:13px;margin-top:4px;">⚠️ Lo escribió sin indicativo de país: confírmalo antes de escribirle.</div>`
    : "";
  return `
  <div style="font-size:22px;font-weight:700;margin:0 0 12px;">${esc(lead.name || "(sin nombre)")}</div>
  <table style="border-collapse:collapse;font-size:15px;margin-bottom:14px;">
    <tr><td style="padding:4px 14px 4px 0;color:#666;">WhatsApp</td><td style="padding:4px 0;"><b>${esc(e164 || lead.phone || "—")}</b>${dudoso}</td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#666;">Correo</td><td style="padding:4px 0;">${esc(lead.email || "—")}</td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#666;">Origen</td><td style="padding:4px 0;font-size:13px;color:#555;">${esc(lead.source || "—")}</td></tr>
  </table>
  ${wa ? `<a href="${esc(wa)}" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;font-size:15px;">Escribirle por WhatsApp</a>` : ""}`;
}

function tablaRespuestas(respuestas: Record<string, string> | null, color: string): string {
  const filas = Object.entries(respuestas || {}).map(
    ([k, v]) =>
      `<tr><td style="padding:5px 12px 5px 0;color:#666;vertical-align:top;">${esc(k)}</td><td style="padding:5px 0;">${esc(v)}</td></tr>`
  );
  if (!filas.length) return "";
  return `<div style="font-size:13px;font-weight:700;color:${color};margin:22px 0 6px;">SUS RESPUESTAS</div>
  <table style="border-collapse:collapse;font-size:14px;">${filas.join("")}</table>`;
}

// El color de marca oscurecido: sobre fondo blanco se tiene que poder leer.
const colorCorreo = (env: Env) => haciaNegro(colorValido(env.BRAND_COLOR), 0.35);

function marco(env: Env, titulo: string, cuerpo: string, torreUrl: string): string {
  const color = colorCorreo(env);
  const negocio = (env.BUSINESS_NAME || "Mi Negocio").toUpperCase();
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#111;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <div style="font-size:12px;letter-spacing:2px;color:${color};font-weight:700;margin-bottom:10px;">${esc(negocio)} · IMPERIO CRM</div>
    <div style="background:#fff;border-radius:12px;padding:22px 20px;border:1px solid #e5e5e5;">
      <div style="font-size:14px;color:${color};font-weight:700;margin-bottom:8px;">${esc(titulo)}</div>
      ${cuerpo}
    </div>
    <div style="font-size:12px;color:#888;margin-top:14px;line-height:1.5;">Ficha completa en tu <a href="${esc(torreUrl)}" style="color:${color};">Torre de Control</a>. Si respondes este correo, le llega al lead.</div>
  </div></body></html>`;
}
