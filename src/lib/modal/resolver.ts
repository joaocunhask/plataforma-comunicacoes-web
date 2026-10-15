// Que linhas do simulador são comissionáveis e a que produto do catálogo Pipedrive
// correspondem. Puro. Port de Infrastructure/Services/Pipedrive/Contract/ContractLineResolver.cs.
//
// É a regra que determina quanto o comercial recebe: um bundle sem PPID no texto levava o
// modelo a copiar o PPID de outra linha, e a comissão saía sobre a oferta errada. Por isso o
// extractor só transcreve e a decisão vive aqui.
import type { NetDecimal } from "@/lib/calculo";

/** Uma linha transcrita do texto colado. pricingPlanId null quando o texto não o traz (bundles). */
export interface LinhaContrato {
  nomeProduto: string;
  quantidade: number;
  duracaoContratoMeses: number;
  multaMensal: NetDecimal;
  pricingPlanId: string | null;
}

export interface ProdutoCatalogo {
  id: number;
  nome: string;
  /** O valor do custom field "Pricing Plan ID" (vazio se não tiver). */
  pricingPlanId: string;
}

export type ResolucaoStatus = "ok" | "ambiguo" | "nao_encontrado" | "ppid_desconhecido";
export type OrigemResolucao = "ppid" | "nome";

export interface Candidato {
  pipedriveProductId: number;
  pricingPlanId: string;
  nome: string;
}

export interface LinhaResolvida {
  linha: LinhaContrato;
  status: ResolucaoStatus;
  origem: OrigemResolucao | null;
  pipedriveProductId: number | null;
  nomeCanonico: string | null;
  pricingPlanId: string | null;
  candidatos: Candidato[];
}

export interface LinhaIgnorada {
  nomeProduto: string;
  motivo: string;
}

export const ehPpidValido = (ppid: string | null | undefined): ppid is string => !!ppid && /^[0-9]{9}$/.test(ppid);

/**
 * O motivo pelo qual a linha não é comissionável, ou null. Sem RLMC (a "Multa Mensal") o
 * upfront é zero; sem duração não há escalão de ajuste. É esta regra — não a presença de um
 * PPID — que separa o produto vendido dos descontos, ofertas e serviços de apoio.
 */
export function motivoNaoComissionavel(l: LinhaContrato): string | null {
  const semDuracao = l.duracaoContratoMeses <= 0;
  const semRlmc = l.multaMensal.lte(0);
  if (semDuracao && semRlmc) return "Sem contrato de permanência nem multa mensal — não gera comissão.";
  if (semDuracao) return "Sem duração de contrato.";
  if (semRlmc) return "Sem multa mensal (RLMC) — o upfront seria zero.";
  return null;
}

/** Sem acentos, maiúsculas, espaços colapsados ("2P PRO + MInf" = "2P PRO + Minf"). */
export function normalizarNome(nome: string | null | undefined): string {
  if (!nome || !nome.trim()) return "";
  return nome
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function resolverLinhas(
  linhas: readonly LinhaContrato[],
  catalogo: readonly ProdutoCatalogo[],
): { linhas: LinhaResolvida[]; ignoradas: LinhaIgnorada[] } {
  const porPpid = new Map<string, ProdutoCatalogo>();
  for (const p of catalogo) if (ehPpidValido(p.pricingPlanId)) porPpid.set(p.pricingPlanId, p); // último ganha

  // Por nome só entram produtos COM pricing_plan_id (os do catálogo central): um produto local
  // do parceiro não pode capturar um nome e levar o cálculo para algo que não é comissionado.
  const porNome = new Map<string, ProdutoCatalogo[]>();
  for (const p of catalogo) {
    if (!p.pricingPlanId.trim()) continue;
    const chave = normalizarNome(p.nome);
    if (!chave) continue;
    porNome.set(chave, [...(porNome.get(chave) ?? []), p]);
  }

  const falha = (linha: LinhaContrato, status: ResolucaoStatus): LinhaResolvida => ({
    linha,
    status,
    origem: null,
    pipedriveProductId: null,
    nomeCanonico: null,
    pricingPlanId: linha.pricingPlanId,
    candidatos: [],
  });

  const resolvidas: LinhaResolvida[] = [];
  const ignoradas: LinhaIgnorada[] = [];
  for (const linha of linhas) {
    const motivo = motivoNaoComissionavel(linha);
    if (motivo) {
      ignoradas.push({ nomeProduto: linha.nomeProduto, motivo });
      continue;
    }

    if (linha.pricingPlanId !== null) {
      const prod = porPpid.get(linha.pricingPlanId);
      resolvidas.push(
        prod
          ? { linha, status: "ok", origem: "ppid", pipedriveProductId: prod.id, nomeCanonico: prod.nome, pricingPlanId: linha.pricingPlanId, candidatos: [] }
          : falha(linha, "ppid_desconhecido"),
      );
      continue;
    }

    const candidatos = porNome.get(normalizarNome(linha.nomeProduto)) ?? [];
    if (candidatos.length === 0) resolvidas.push(falha(linha, "nao_encontrado"));
    else if (candidatos.length === 1) {
      const p = candidatos[0];
      resolvidas.push({ linha, status: "ok", origem: "nome", pipedriveProductId: p.id, nomeCanonico: p.nome, pricingPlanId: p.pricingPlanId, candidatos: [] });
    } else {
      // Mesmo nome, classificações diferentes (GOLD vs BRONZE) = multiplicadores diferentes.
      // Escolher por nós seria arbitrar dinheiro: desempata o comercial.
      resolvidas.push({
        linha,
        status: "ambiguo",
        origem: null,
        pipedriveProductId: null,
        nomeCanonico: null,
        pricingPlanId: null,
        candidatos: candidatos.map((p) => ({ pipedriveProductId: p.id, pricingPlanId: p.pricingPlanId, nome: p.nome })),
      });
    }
  }
  return { linhas: resolvidas, ignoradas };
}
