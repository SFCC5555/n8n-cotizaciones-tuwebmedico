import {
  bundlePrice,
  ivaBreakdown,
  maintenanceQuote,
  maxMonthlyMonths,
  moduleById,
  platformModules,
  type MaintenanceChoice,
  type ModuleId,
} from "@/lib/modules";
import { getSpecialty } from "@/lib/specialties";

// Cotización por correo desde la calculadora de la propuesta.
// La página manda solo el correo, los módulos y el mantenimiento elegidos; aquí se recalculan los precios con los de modules.ts (nunca se
// confía en un precio que venga del navegador), se arma la «foto» de la cotización y se envía al flujo de n8n, que la
// guarda en Google Sheets, manda el correo al doctor y avisa por Slack. La dirección del webhook y su clave secreta
// viven solo en el servidor (variables de entorno), nunca en el navegador.

const VALID_DAYS = 30;
const validIds = new Set<string>(platformModules.map((m) => m.id));
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Código legible y difícil de adivinar: COT-261026-K7QM. Se genera aquí y no en n8n, para no depender de contar filas
// en la hoja (dos cotizaciones al mismo tiempo podrían recibir el mismo número).
function quoteCode(now: Date) {
  const date = now.toISOString().slice(2, 10).replaceAll("-", "");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin 0/O ni 1/I, que se confunden al dictarlo
  const random = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => alphabet[b % alphabet.length]).join("");
  return `COT-${date}-${random}`;
}

// Los módulos tienen que formar una combinación posible: con sus requisitos y sin 6A y 6B juntos.
function validSelection(ids: ModuleId[]) {
  if (!ids.includes("1")) return false;
  if (ids.includes("6A") && ids.includes("6B")) return false;
  return ids.every((id) => !moduleById[id].needs || ids.includes(moduleById[id].needs!));
}

// Mantenimiento: «despues» (lo decide al terminar el mes incluido), mensual por los meses en que todavía conviene frente
// al anual, o anual del primer año.
function maintenanceChoice(raw: unknown, ids: ModuleId[]): MaintenanceChoice | null {
  const m = (raw ?? { tipo: "despues" }) as { tipo?: unknown; meses?: unknown };
  if (m.tipo === "despues") return { kind: "despues" };
  if (m.tipo === "anual") return { kind: "anual" };
  const months = Number(m.meses);
  if (m.tipo === "mensual" && Number.isInteger(months) && months >= 1 && months <= maxMonthlyMonths(ids)) return { kind: "mensual", months };
  return null;
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "datos" }, { status: 400 });
  }

  // Campo trampa: invisible para personas, los robots que llenan todo lo completan.
  if (body.website) return Response.json({ ok: true, codigo: "COT-000000-XXXX" });

  const email = String(body.email ?? "").trim().toLowerCase().slice(0, 120);
  const name = String(body.nombre ?? "").trim().slice(0, 80);
  const specialty = getSpecialty(String(body.esp ?? ""));
  const raw = Array.isArray(body.modulos) ? body.modulos.map(String) : [];
  // Sin repetidos y en el orden de la propuesta.
  const ids = platformModules.map((m) => m.id).filter((id) => raw.includes(id) && validIds.has(id));

  const choice = maintenanceChoice(body.mantenimiento, ids);

  if (!emailPattern.test(email) || !specialty || !validSelection(ids) || !choice) {
    return Response.json({ ok: false, error: "datos" }, { status: 400 });
  }

  const webhook = process.env.N8N_COTIZACION_URL;
  const secret = process.env.N8N_COTIZACION_SECRET;
  // Sin el flujo configurado (por ejemplo, en local o si venció la prueba de n8n), la página ofrece WhatsApp.
  if (!webhook || !secret) return Response.json({ ok: false, error: "no-disponible" }, { status: 503 });

  const now = new Date();
  const validUntil = new Date(now.getTime() + VALID_DAYS * 24 * 60 * 60 * 1000);
  const { list, rate, total, saved } = bundlePrice(ids);
  const { base, iva } = ivaBreakdown(total);
  const code = quoteCode(now);
  const upkeep = maintenanceQuote(ids, choice);
  const proposal = `https://tuwebmedico.com/${specialty.id}/propuesta`;

  // La «foto» de la cotización: si después cambian los precios, esta se respeta hasta su fecha de vencimiento.
  const quote = {
    codigo: code,
    emitida: now.toISOString(),
    validaHasta: validUntil.toISOString(),
    diasValidez: VALID_DAYS,
    nombre: name,
    correo: email,
    especialidad: specialty.field,
    propuesta: proposal,
    modulos: ids.map((id) => ({ id, nombre: moduleById[id].name, precio: moduleById[id].price })),
    precioLista: list,
    descuentoPorcentaje: Math.round(rate * 100),
    ahorro: saved,
    total,
    base,
    iva,
    mantenimiento: {
      tipo: upkeep.kind,
      meses: upkeep.months,
      mensual: upkeep.monthly,
      total: upkeep.total,
      ahorro: upkeep.saving,
    },
    // Desarrollo más el mantenimiento elegido (se pagan en momentos distintos; el correo lo aclara).
    totalConMantenimiento: total + upkeep.total,
  };

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cotizacion-Secret": secret },
      body: JSON.stringify(quote),
      // Si n8n no responde en 15 s, la página no deja al doctor esperando: le ofrece WhatsApp.
      signal: AbortSignal.timeout(15000),
    });
    const result = (await res.json().catch(() => ({}))) as { ok?: boolean };
    if (!res.ok || result.ok === false) return Response.json({ ok: false, error: "envio" }, { status: 502 });
  } catch {
    return Response.json({ ok: false, error: "envio" }, { status: 502 });
  }

  return Response.json({ ok: true, codigo: quote.codigo, validaHasta: quote.validaHasta });
}
