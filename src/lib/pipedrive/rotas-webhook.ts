// Os handlers HTTP dos webhooks (src/app/webhooks/pipedrive/*/route.ts). Públicos: a
// autenticação é o webhook_token da empresa, no corpo (/upfront) ou no Basic Auth (/native).
import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orgEmpresas } from "@/db/schema";
import { apurarUpfront, type ResultadoUpfront } from "@/lib/apuramento/upfront";
import { ErroPipedrive } from "./cliente";
import {
  ehTransicaoParaGanho,
  entradaDoNativo,
  lerPayloadUpfront,
  tokenDoBasicAuth,
  type EntradaUpfront,
  type PayloadNativo,
} from "./webhooks";

/** Results.Problem do ASP.NET: application/problem+json. */
export function problema(detail: string, status: number): Response {
  return Response.json({ title: tituloDe(status), status, detail }, { status, headers: { "Content-Type": "application/problem+json" } });
}

function tituloDe(status: number): string {
  return { 400: "Bad Request", 401: "Unauthorized", 409: "Conflict" }[status] ?? "An error occurred while processing your request.";
}

async function empresaDoToken(token: string): Promise<number | null> {
  const [empresa] = await db
    .select({ id: orgEmpresas.id })
    .from(orgEmpresas)
    .where(and(eq(orgEmpresas.webhookToken, token), eq(orgEmpresas.ativo, true)))
    .limit(1);
  return empresa?.id ?? null;
}

async function lerJson(pedido: Request): Promise<unknown> {
  try {
    return await pedido.json();
  } catch {
    return undefined;
  }
}

async function apurar(entrada: EntradaUpfront, empresaId: number, motivoAcerto: string): Promise<Response> {
  let r: ResultadoUpfront;
  try {
    r = await apurarUpfront(entrada, empresaId, { motivoAcerto });
  } catch (e) {
    console.error(`Webhook upfront falhou | Empresa ${empresaId} | Deal ${entrada.idNegocio}`, e);
    return problema(e instanceof ErroPipedrive ? e.message : "Erro interno ao apurar o upfront.", 500);
  }
  if (!r.ok) return problema(r.mensagem, r.statusCode);
  return Response.json(
    r.ignorado
      ? { linhas_criadas: 0, linhas_sem_calculo: 0, ignorado: true }
      : { linhas_criadas: r.linhasCriadas, linhas_sem_calculo: r.linhasSemCalculo, ignorado: false },
  );
}

/** POST /webhooks/pipedrive/upfront — ação de webhook de uma automação. */
export async function webhookUpfront(pedido: Request): Promise<Response> {
  const corpo = await lerJson(pedido);
  if (corpo === undefined) return problema("Corpo JSON inválido.", 400);
  const leitura = lerPayloadUpfront(corpo);
  if (!leitura.ok) return problema(leitura.mensagem, leitura.status);

  const empresaId = await empresaDoToken(leitura.webhookToken);
  if (empresaId === null) return problema("webhook_token não corresponde a nenhuma empresa ativa.", 401);

  return apurar(leitura.entrada, empresaId, "Reprocessamento automático — negócio ganho no Pipedrive (automação)");
}

/** POST /webhooks/pipedrive/native — webhook nativo em updated.deal. */
export async function webhookNativo(pedido: Request): Promise<Response> {
  const token = tokenDoBasicAuth(pedido.headers.get("authorization"));
  if (!token) return problema("Basic Auth em falta ou inválido.", 401);

  const empresaId = await empresaDoToken(token);
  if (empresaId === null) return problema("Credenciais não correspondem a nenhuma empresa ativa.", 401);

  const corpo = await lerJson(pedido);
  if (corpo === undefined || corpo === null || typeof corpo !== "object") return problema("Corpo JSON inválido.", 400);
  const payload = corpo as PayloadNativo;

  if (!ehTransicaoParaGanho(payload)) return Response.json({ ignorado: true, motivo: "Não é transição para ganho." });

  const entrada = entradaDoNativo(payload);
  if (!entrada) return problema("Payload nativo sem campos obrigatórios (id/pipeline_id/user_id).", 400);

  return apurar(entrada, empresaId, "Reprocessamento automático — negócio ganho no Pipedrive (webhook nativo)");
}
