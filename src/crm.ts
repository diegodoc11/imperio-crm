// ============================================================
//  IMPERIO CRM · Piezas compartidas
//  El tipo Env, los helpers de base de datos y utilidades que
//  usan el Worker (index.ts), la Torre (torre.ts) y los avisos (avisos.ts).
// ============================================================

export const VERSION = "1.1.0";

export interface Env {
  DB: D1Database;
  BUSINESS_NAME?: string;
  BRAND_COLOR?: string;
  TIMEZONE?: string;
  PAIS_TELEFONO?: string; // indicativo de tu país ("57" = Colombia): completa los WhatsApp que llegan sin él
  TORRE_KEY?: string; // opcional: clave fija por secreto (si no, se crea en la primera visita a /torre)
  // ---- Avisos a tu correo (opcional, por Brevo) ----
  BREVO_API_KEY?: string; // secreto
  AVISO_EMAIL?: string; // a dónde te llegan los avisos (secreto, para que tu correo no quede en GitHub)
  AVISO_REMITENTE?: string; // remitente verificado en Brevo (si está vacío, usa AVISO_EMAIL)
  AVISOS?: string; // cuándo avisarte: "nuevo,agendo" (por defecto) · "agendo" · "no"
  BREVO_LISTA_ID?: string; // opcional: id de tu lista de Brevo para meter ahí a cada lead con correo
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });

// Limpia un texto que viene de afuera: recorta espacios y limita el largo.
export const texto = (v: unknown, max = 300): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------- El embudo ----------
export const ESTADOS_VALIDOS = ["nuevo", "curioso", "tibio", "caliente", "calificado", "agendo", "comprador", "baja"];

// Orden del embudo: un formulario solo puede SUBIR a un lead, nunca bajarlo
// (si ya era comprador y vuelve a llenar el formulario, sigue siendo comprador).
export const RANGO: Record<string, number> = {
  nuevo: 0, curioso: 1, tibio: 2, caliente: 3, calificado: 4, agendo: 5, comprador: 6,
};

// ---------- WhatsApp: siempre con indicativo de país ----------
// La gente escribe su WhatsApp sin indicativo aunque se lo pidas (3001234567).
// Sin el +57 no se le puede escribir desde un link ni llamarlo desde otro país.
// Aquí se completa cuando NO hay ambigüedad; si no se puede saber el país,
// devuelve null y la Torre y el correo te avisan que lo confirmes.
//
// Celulares por país: largo del número sin indicativo y cómo empieza.
// "cero": en ese país la gente escribe un 0 adelante (0991234567 en Ecuador).
// "extra": dígito que WhatsApp exige después del indicativo (Argentina: +54 9).
const CELULARES: Record<string, { largo: number; inicio?: RegExp; cero?: boolean; extra?: string }> = {
  "57": { largo: 10, inicio: /^3/ }, //                 Colombia      300 123 4567
  "52": { largo: 10 }, //                               México        55 1234 5678
  "593": { largo: 9, inicio: /^9/, cero: true }, //     Ecuador       099 123 4567
  "51": { largo: 9, inicio: /^9/ }, //                  Perú          912 345 678
  "56": { largo: 9, inicio: /^9/ }, //                  Chile         9 1234 5678
  "58": { largo: 10, inicio: /^4/, cero: true }, //     Venezuela     0412 123 4567
  "54": { largo: 10, cero: true, extra: "9" }, //       Argentina     11 2345 6789
  "591": { largo: 8, inicio: /^[67]/ }, //              Bolivia
  "595": { largo: 9, inicio: /^9/, cero: true }, //     Paraguay      0981 123 456
  "598": { largo: 8, inicio: /^9/, cero: true }, //     Uruguay       094 123 456
  "506": { largo: 8 }, //                               Costa Rica
  "507": { largo: 8, inicio: /^6/ }, //                 Panamá
  "502": { largo: 8 }, //                               Guatemala
  "503": { largo: 8 }, //                               El Salvador
  "504": { largo: 8 }, //                               Honduras
  "505": { largo: 8 }, //                               Nicaragua
  "1": { largo: 10 }, //                                EE. UU., Canadá, Rep. Dominicana, Puerto Rico
  "34": { largo: 9, inicio: /^[67]/ }, //               España
  "55": { largo: 11 }, //                               Brasil
};

export function paisTelefono(env: Env): string {
  const p = String(env.PAIS_TELEFONO ?? "57").replace(/\D/g, "");
  return p || "57";
}

// "+573001234567" o null si no se puede saber el país.
export function normalizarTelefono(raw: unknown, pais = "57"): string | null {
  const limpio = String(raw ?? "").trim();
  if (!limpio) return null;
  let d = limpio.replace(/\D/g, "");
  if (limpio.startsWith("+") || limpio.startsWith("00")) {
    if (!limpio.startsWith("+")) d = d.slice(2);
    return d.length >= 8 && d.length <= 15 ? "+" + d : null;
  }
  const p = CELULARES[pais];
  if (p) {
    const cuerpo = (x: string) => x.length === p.largo && (!p.inicio || p.inicio.test(x));
    // 1) Número local: 300 123 4567 (o 099 123 4567 donde se escribe el 0).
    const local = p.cero && d.startsWith("0") ? d.slice(1) : d;
    if (cuerpo(local)) return "+" + pais + (p.extra ?? "") + local;
    // 2) Trae el indicativo pero le faltó el "+": 573001234567.
    if (d.startsWith(pais)) {
      let resto = d.slice(pais.length);
      if (p.extra && resto.length === p.largo + p.extra.length && resto.startsWith(p.extra)) resto = resto.slice(p.extra.length);
      if (cuerpo(resto)) return "+" + pais + (p.extra ?? "") + resto;
    }
  }
  // 3) Número largo de otro país que ya trae su indicativo (525512345678).
  if (!d.startsWith("0") && d.length >= 11 && d.length <= 15) return "+" + d;
  return null;
}

// Link que abre el chat de WhatsApp con un saludo ya escrito.
export function linkWhatsApp(e164: string | null, saludo = ""): string | null {
  if (!e164) return null;
  return "https://wa.me/" + e164.slice(1) + (saludo ? "?text=" + encodeURIComponent(saludo) : "");
}

// ---------- Fechas en TU zona horaria ----------
export function zonaHoraria(env: Env): string {
  const tz = env.TIMEZONE || "America/Bogota";
  return /^[A-Za-z0-9_+\/-]+$/.test(tz) ? tz : "America/Bogota";
}

// "lunes, 28 de septiembre, 3:00 p. m." en la zona horaria del negocio.
export function fechaLegible(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("es", {
      weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// ---------- Colores de marca: del hex del negocio salen las variantes ----------
export function colorValido(c: string | undefined): string {
  return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : "#cdb68c";
}
export function canal(hex: string, i: number): number {
  return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
}
function aHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}
export function haciaBlanco(hex: string, p: number): string {
  const [r, g, b] = [canal(hex, 0), canal(hex, 1), canal(hex, 2)];
  return aHex(r + (255 - r) * p, g + (255 - g) * p, b + (255 - b) * p);
}
export function haciaNegro(hex: string, p: number): string {
  return aHex(canal(hex, 0) * (1 - p), canal(hex, 1) * (1 - p), canal(hex, 2) * (1 - p));
}

// ---------- CRM: una fila en `leads` por persona ----------
export interface UpsertInput {
  channel: string;
  externalId: string;
  name?: string | null;
  source?: string | null;
  phone?: string | null;
  email?: string | null;
}

export async function upsertLead(env: Env, i: UpsertInput): Promise<{ id: number; status: string }> {
  const row = await env.DB.prepare(
    `INSERT INTO leads (channel, external_id, name, source, phone, email)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel, external_id) DO UPDATE SET
       last_seen = datetime('now'),
       name   = COALESCE(excluded.name,  leads.name),
       phone  = COALESCE(excluded.phone, leads.phone),
       email  = COALESCE(excluded.email, leads.email),
       source = COALESCE(leads.source, excluded.source)
     RETURNING id, status`
  )
    .bind(i.channel, i.externalId, i.name ?? null, i.source ?? null, i.phone ?? null, i.email ?? null)
    .first<{ id: number; status: string }>();
  if (!row) throw new Error("upsertLead: la base de datos no devolvió la fila");
  return row;
}

export async function registrarEvento(env: Env, leadId: number, type: string, payload?: unknown): Promise<void> {
  await env.DB.prepare("INSERT INTO events (lead_id, type, payload) VALUES (?, ?, ?)")
    .bind(leadId, type, payload === undefined ? null : JSON.stringify(payload))
    .run();
}

// Último evento de un tipo, con su payload ya convertido de JSON.
async function ultimoEvento<T>(env: Env, leadId: number, type: string): Promise<T | null> {
  const r = await env.DB.prepare(
    "SELECT payload FROM events WHERE lead_id = ? AND type = ? ORDER BY id DESC LIMIT 1"
  )
    .bind(leadId, type)
    .first<{ payload: string | null }>();
  if (!r?.payload) return null;
  try {
    return JSON.parse(r.payload) as T;
  } catch {
    return null;
  }
}

export type Respuestas = Record<string, string>;
export interface Cita {
  inicio?: string; // ISO (lo manda cal.com u otra agenda)
  texto?: string; // si la fecha llegó en texto libre, tal cual
}

export const ultimasRespuestas = (env: Env, leadId: number) => ultimoEvento<Respuestas>(env, leadId, "respuestas");
export const ultimaCita = (env: Env, leadId: number) => ultimoEvento<Cita>(env, leadId, "cita");

// La cita lista para mostrar: en TU hora si llegó con fecha exacta.
export function citaLegible(c: Cita | null, tz: string): string | null {
  if (!c) return null;
  if (c.inicio) return fechaLegible(c.inicio, tz);
  return c.texto ? `${c.texto} (como la escribió el lead)` : null;
}

// Ficha completa de un lead (datos + conversación).
export async function getLeadContext(env: Env, id: number) {
  const lead = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
  if (!lead) return null;
  const msgs = await env.DB.prepare(
    "SELECT role, content, created_at FROM messages WHERE lead_id = ? ORDER BY id ASC"
  )
    .bind(id)
    .all();
  return { lead, messages: msgs.results ?? [] };
}
