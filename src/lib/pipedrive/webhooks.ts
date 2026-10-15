// Os dois webhooks do Pipedrive, sem I/O: autenticação, leitura do payload e decisão de
// processar. Port de API/Endpoints/WebhooksEndpoints.cs e API/Services/PipedriveNativeWebhookMapper.cs.
//
//   /upfront — ação de webhook de uma automação; payload plano com strings e o
//              webhook_token da empresa no corpo.
//   /native  — webhook nativo (Tools → Webhooks) em updated.deal, a nível de conta, para
//              os negócios de qualquer comercial; o webhook_token vai como password do Basic Auth.
import type { DataCivil } from "@/lib/calculo";
import { dataCivil, tryParseIntNet } from "@/lib/calculo";

/** O que o apuramento consome (UpfrontWebhookInput no C#). */
export interface EntradaUpfront {
  idFunil: number;
  nomeFunil: string | null;
  idNegocio: number;
  tituloNegocio: string | null;
  idComercial: number;
  contactoServico: string | null;
  inicioContrato: DataCivil | null;
  idSimulador: string | null;
  oportunidade: string | null;
}

const RE_GUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Guid.TryParse: aceita com ou sem hífens, entre {} ou (); devolve a forma do Postgres. */
export function lerGuid(texto: string | null | undefined): string | null {
  if (texto == null) return null;
  let t = texto.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("(") && t.endsWith(")"))) t = t.slice(1, -1);
  if (!RE_GUID.test(t)) return null;
  const h = t.replace(/-/g, "").toLowerCase();
  if (t.includes("-") && t.length !== 36) return null;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A password de `Authorization: Basic base64(user:pass)` como GUID; o username é ignorado. */
export function tokenDoBasicAuth(cabecalho: string | null): string | null {
  if (!cabecalho || !cabecalho.trim()) return null;
  if (!cabecalho.toLowerCase().startsWith("basic ")) return null;
  const b64 = cabecalho.slice(6).trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return null;
  const decodificado = Buffer.from(b64, "base64").toString("utf8");
  const sep = decodificado.indexOf(":");
  return sep < 0 ? null : lerGuid(decodificado.slice(sep + 1));
}

const RE_DATA_HORA = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i;

/**
 * Data de início tolerante: data pura ("2026-07-31") ou data e hora ("2026-07-31 15:35:36",
 * ISO com "Z"). A automação manda a data de ganho, que traz hora. Com um fuso explícito
 * diferente de Z, passa a UTC (a API .NET corre em UTC). Inválida ou vazia → null.
 */
export function lerDataInicio(texto: string | null | undefined): DataCivil | null {
  if (texto == null || !texto.trim()) return null;
  const m = RE_DATA_HORA.exec(texto.trim());
  if (!m) return null;
  const [, a, me, d, h = "00", mi = "00", s = "00", fuso] = m;
  try {
    if (!fuso || fuso.toUpperCase() === "Z") return dataCivil(`${a}-${me}-${d}`);
    const instante = new Date(`${a}-${me}-${d}T${h}:${mi}:${s}${fuso.length === 5 ? `${fuso.slice(0, 3)}:${fuso.slice(3)}` : fuso}`);
    if (Number.isNaN(instante.getTime())) return null;
    return dataCivil(instante.toISOString().slice(0, 10));
  } catch {
    return null;
  }
}

// ── /upfront ─────────────────────────────────────────────────────────────────

/** Campo do payload da automação: chega como string (aceita-se também número). */
function campo(corpo: Record<string, unknown>, nome: string): string | null {
  const v = corpo[nome];
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export type LeituraUpfront =
  | { ok: true; webhookToken: string; entrada: EntradaUpfront }
  | { ok: false; status: 400 | 401; mensagem: string };

export function lerPayloadUpfront(corpo: unknown): LeituraUpfront {
  const c = corpo !== null && typeof corpo === "object" ? (corpo as Record<string, unknown>) : {};
  const token = lerGuid(campo(c, "webhook_token"));
  if (!token) return { ok: false, status: 401, mensagem: "webhook_token em falta ou inválido." };

  const idFunil = tryParseIntNet(campo(c, "id_funil"));
  if (idFunil === null) return { ok: false, status: 400, mensagem: "id_funil inválido." };
  const idNegocio = tryParseIntNet(campo(c, "id_negocio"));
  if (idNegocio === null) return { ok: false, status: 400, mensagem: "id_negocio inválido." };
  const idComercial = tryParseIntNet(campo(c, "id_comercial"));
  if (idComercial === null) return { ok: false, status: 400, mensagem: "id_comercial inválido." };

  return {
    ok: true,
    webhookToken: token,
    entrada: {
      idFunil,
      nomeFunil: campo(c, "nome_funil"),
      idNegocio,
      tituloNegocio: campo(c, "titulo_negocio"),
      idComercial,
      contactoServico: campo(c, "contacto_servico"),
      // duracao_contrato deixou de se usar: a duração vem por subscrição, das observações.
      inicioContrato: lerDataInicio(campo(c, "inicio_contrato")),
      idSimulador: campo(c, "id_simulador"),
      oportunidade: campo(c, "oportunidade"),
    },
  };
}

// ── /native ──────────────────────────────────────────────────────────────────

interface NegocioNativo {
  id?: unknown;
  title?: unknown;
  pipeline_id?: unknown;
  status?: unknown;
  owner_id?: unknown;
  user_id?: unknown;
  won_time?: unknown;
}

/** Payload v1 (`current`) ou v2 (`data`). */
export interface PayloadNativo {
  current?: NegocioNativo | null;
  data?: NegocioNativo | null;
  previous?: NegocioNativo | null;
}

const negocioDe = (p: PayloadNativo): NegocioNativo | null => p.current ?? p.data ?? null;
const ehGanho = (status: unknown) => typeof status === "string" && status.toLowerCase() === "won";
const int32 = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? v : null;

function idDoDono(v: unknown): number | null {
  if (typeof v === "number") return int32(v);
  if (typeof v === "string") return tryParseIntNet(v);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return int32(o.id) ?? int32(o.value);
  }
  return null;
}

/**
 * Só a transição para ganho conta (o nativo dispara em todas as atualizações). Um negócio
 * criado já ganho (sem `previous`) também conta.
 */
export function ehTransicaoParaGanho(p: PayloadNativo): boolean {
  const negocio = negocioDe(p);
  return negocio !== null && ehGanho(negocio.status) && !ehGanho(p.previous?.status);
}

/**
 * A entrada do apuramento a partir do payload nativo; null se faltar o id, o pipeline_id
 * ou o dono. Oportunidade e id_simulador ficam null: o apuramento relê-os do negócio.
 */
export function entradaDoNativo(p: PayloadNativo): EntradaUpfront | null {
  const negocio = negocioDe(p);
  if (!negocio) return null;
  const idNegocio = int32(negocio.id);
  const idFunil = int32(negocio.pipeline_id);
  const idComercial = idDoDono(negocio.owner_id) ?? idDoDono(negocio.user_id);
  if (idNegocio === null || idFunil === null || idComercial === null) return null;
  return {
    idFunil,
    nomeFunil: null,
    idNegocio,
    tituloNegocio: typeof negocio.title === "string" ? negocio.title : null,
    idComercial,
    contactoServico: null,
    inicioContrato: lerDataInicio(typeof negocio.won_time === "string" ? negocio.won_time : null),
    idSimulador: null,
    oportunidade: null,
  };
}
