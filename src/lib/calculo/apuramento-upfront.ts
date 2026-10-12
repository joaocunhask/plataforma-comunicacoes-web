// Apuramento do upfront de um negócio ganho, sem I/O. Port da lógica de
// API/Services/UpfrontApuramentoService.cs; quem chama lê a BD e o Pipedrive e grava.
//
// Passos, como no C#:
//   1. produtosQuePrecisamDeDetalhes → quem chama vai ao Pipedrive buscar os detalhes
//      (custom fields) só desses produtos;
//   2. calcularLinhasUpfront → uma linha de cálculo por subscrição;
//   3. verificarEstadoParaReprocessar → ANULADO/PROCESSADO não se reprocessam (409);
//   4. prepararGravacaoUpfront → as linhas a inserir (com a data de início preservada)
//      e o acerto RECALCULO, se o dinheiro mudou.

import type { DataCivil } from "./datas";
import { NetDecimal } from "./decimal-net";
import { EstadosNegocio } from "./estados-negocio";
import { lerSubscricoes, type SubscricaoContrato } from "./observacoes";
import { TiposAcerto } from "./tipos-acerto";
import { trimNet, tryParseIntNet, vazioNet, vazioOuEspacosNet } from "./texto-net";
import { calcularUpfront, type UpfrontLinhaResultado } from "./upfront";

/** Um produto do negócio, como vem de GET /deals/{id}/products. */
export interface ProdutoDoNegocio {
  produtoId: number;
  nome: string | null;
  /** item_price. */
  precoUnitario: NetDecimal;
  /** comments (as observações escritas pela app). */
  observacoes: string | null;
}

/** Os custom fields do produto (GET /products/{id}), já como texto. */
export interface DetalhesProduto {
  /** Valor do campo mapeado como "classificacao_oferta" (o option id). */
  classificacaoOferta: string | null;
  /** Valor do campo mapeado como "pricing_plan_id"; null se o campo não estiver mapeado. */
  pricingPlanId: string | null;
}

/** ref_ajuste_comissao_vodafone da empresa. */
export interface AjusteDuracao {
  duracaoMin: number;
  duracaoMax: number;
  ajuste: NetDecimal;
}

export interface ConfigUpfront {
  /** org_empresa_oferta_pipedrive: option id do Pipedrive → oferta. */
  ofertaPorOption: ReadonlyMap<number, number>;
  /** Plano comissional (tipo de receita do funil, objetivos_atingidos = 0): oferta → upfront. */
  planoPorOferta: ReadonlyMap<number, NetDecimal>;
  /** Pela ordem da consulta: com faixas sobrepostas ganha a primeira (ordenar por id). */
  ajustesDuracao: readonly AjusteDuracao[];
  /** Margem de upfront ativa do comercial (% do parceiro); null → 100. */
  margemUpfrontPct: NetDecimal | null;
}

export interface LinhaUpfrontCalculada {
  produtoId: number;
  descricaoProduto: string | null;
  /** Número associado (MSISDN) da subscrição, se tiver. */
  numeroAssociado: string | null;
  duracaoMeses: number;
  /** 1 (com número) ou N (sem número, cálculo sobre o total). */
  quantidade: number;
  ofertaId: number;
  upfrontPlano: NetDecimal;
  ajusteDuracao: NetDecimal;
  valorUnidade: NetDecimal;
  pricingPlanId: string | null;
  resultado: UpfrontLinhaResultado;
}

/** Porque é que um produto ou subscrição ficou sem cálculo (os avisos do log do C#). */
export type AvisoUpfront =
  | { tipo: "sem-observacoes"; produtoId: number }
  | { tipo: "produto-nao-encontrado"; produtoId: number; subscricoes: number }
  | { tipo: "classificacao-invalida"; produtoId: number; valor: string | null; subscricoes: number }
  | { tipo: "option-sem-mapeamento"; produtoId: number; optionId: number; subscricoes: number }
  | { tipo: "sem-plano-comissional"; produtoId: number; ofertaId: number; subscricoes: number }
  | { tipo: "sem-ajuste-duracao"; produtoId: number; duracaoMeses: number };

/** Os produtos de que é preciso ir buscar os detalhes: os que têm subscrições. */
export function produtosQuePrecisamDeDetalhes(produtos: readonly ProdutoDoNegocio[]): number[] {
  const ids = new Set<number>();
  for (const p of produtos) if (lerSubscricoes(p.observacoes).length > 0) ids.add(p.produtoId);
  return [...ids];
}

/**
 * Uma linha de cálculo por subscrição de cada produto. Os detalhes só são lidos para os
 * produtos com subscrições; um id em falta no mapa é um erro de quem chama (lança),
 * enquanto null quer dizer "o Pipedrive não encontrou o produto".
 */
export function calcularLinhasUpfront(
  produtos: readonly ProdutoDoNegocio[],
  detalhesPorProduto: ReadonlyMap<number, DetalhesProduto | null>,
  config: ConfigUpfront,
): { linhas: LinhaUpfrontCalculada[]; linhasSemCalculo: number; avisos: AvisoUpfront[] } {
  const linhas: LinhaUpfrontCalculada[] = [];
  const avisos: AvisoUpfront[] = [];
  let linhasSemCalculo = 0;

  const ajustePorDuracao = new Map<number, NetDecimal | null>();
  const obterAjuste = (duracao: number): NetDecimal | null => {
    let ajuste = ajustePorDuracao.get(duracao);
    if (ajuste === undefined) {
      ajuste = config.ajustesDuracao.find((a) => a.duracaoMin <= duracao && a.duracaoMax >= duracao)?.ajuste ?? null;
      ajustePorDuracao.set(duracao, ajuste);
    }
    return ajuste;
  };

  for (const p of produtos) {
    const subscricoes: SubscricaoContrato[] = lerSubscricoes(p.observacoes);
    if (subscricoes.length === 0) {
      avisos.push({ tipo: "sem-observacoes", produtoId: p.produtoId });
      linhasSemCalculo++;
      continue;
    }

    if (!detalhesPorProduto.has(p.produtoId)) {
      throw new Error(`calcularLinhasUpfront: faltam os detalhes do produto ${p.produtoId}.`);
    }
    const detalhes = detalhesPorProduto.get(p.produtoId) ?? null;
    if (detalhes === null) {
      avisos.push({ tipo: "produto-nao-encontrado", produtoId: p.produtoId, subscricoes: subscricoes.length });
      linhasSemCalculo += subscricoes.length;
      continue;
    }

    const optionId = tryParseIntNet(detalhes.classificacaoOferta);
    if (optionId === null) {
      avisos.push({
        tipo: "classificacao-invalida",
        produtoId: p.produtoId,
        valor: detalhes.classificacaoOferta,
        subscricoes: subscricoes.length,
      });
      linhasSemCalculo += subscricoes.length;
      continue;
    }

    const ofertaId = config.ofertaPorOption.get(optionId);
    if (ofertaId === undefined) {
      avisos.push({ tipo: "option-sem-mapeamento", produtoId: p.produtoId, optionId, subscricoes: subscricoes.length });
      linhasSemCalculo += subscricoes.length;
      continue;
    }

    const upfrontPlano = config.planoPorOferta.get(ofertaId);
    if (upfrontPlano === undefined) {
      avisos.push({ tipo: "sem-plano-comissional", produtoId: p.produtoId, ofertaId, subscricoes: subscricoes.length });
      linhasSemCalculo += subscricoes.length;
      continue;
    }

    const pricingPlanId = detalhes.pricingPlanId === null ? null : trimNet(detalhes.pricingPlanId);

    // Uma linha por subscrição; o arredondamento é por subscrição (cada uma é um contrato).
    for (const sub of subscricoes) {
      const ajuste = obterAjuste(sub.duracaoMeses);
      if (ajuste === null) {
        avisos.push({ tipo: "sem-ajuste-duracao", produtoId: p.produtoId, duracaoMeses: sub.duracaoMeses });
        linhasSemCalculo++;
        continue;
      }

      linhas.push({
        produtoId: p.produtoId,
        descricaoProduto: p.nome,
        numeroAssociado: sub.numero,
        duracaoMeses: sub.duracaoMeses,
        quantidade: sub.quantidade,
        ofertaId,
        upfrontPlano,
        ajusteDuracao: ajuste,
        valorUnidade: p.precoUnitario,
        pricingPlanId,
        resultado: calcularUpfront({
          valorUnidade: p.precoUnitario,
          quantidade: sub.quantidade,
          upfrontPlano,
          ajusteDuracao: ajuste,
          margemUpfrontPct: config.margemUpfrontPct,
        }),
      });
    }
  }

  return { linhas, linhasSemCalculo, avisos };
}

/** Lê um custom field deal-level: null se vazio, para quem chama aplicar o fallback ao payload. */
export function lerCampoDoNegocio(valor: string | null | undefined): string | null {
  if (valor == null) return null;
  const v = trimNet(valor);
  return vazioNet(v) ? null : v;
}

/**
 * Negócios ANULADOS ou já PROCESSADOS no trimestral não se reprocessam em silêncio:
 * o admin tem de os reativar no painel. EM_VALIDACAO reprocessa (e mantém o estado).
 */
export function verificarEstadoParaReprocessar(
  estadoAtual: string | null,
  idNegocio: number,
): { bloqueado: false } | { bloqueado: true; statusCode: 409; mensagem: string } {
  if (estadoAtual === EstadosNegocio.Anulado || estadoAtual === EstadosNegocio.Processado) {
    return {
      bloqueado: true,
      statusCode: 409,
      mensagem: `Negócio ${idNegocio} está em estado ${estadoAtual}; re-active-o no painel Admin para permitir reprocessamento.`,
    };
  }
  return { bloqueado: false };
}

/** Uma linha que já existia (vai ser apagada e substituída). */
export interface LinhaUpfrontExistente {
  produtoId: number | null;
  numeroAssociado: string | null;
  dataInicioContrato: DataCivil | null;
  valorUpfrontBruto: NetDecimal | null;
  valorUpfrontLiquido: NetDecimal | null;
  premiosBruto: NetDecimal | null;
  premiosLiquido: NetDecimal | null;
}

/** Os valores de uma linha de sys_calculo_comissoes a inserir (os ids e as datas de cálculo são de quem grava). */
export interface LinhaUpfrontAGravar {
  descricaoProduto: string | null;
  produtoId: number;
  duracaoContrato: number;
  dataInicioContrato: DataCivil | null;
  quantidade: number;
  numeroAssociado: string | null;
  pricingPlanId: string | null;
  upfront: NetDecimal;
  /** O id da oferta como texto (convenção herdada do n8n). */
  oferta: string;
  valorUnidade: NetDecimal;
  ajusteDuracao: NetDecimal;
  /** A margem efetivamente aplicada (100 se não havia), para o histórico ser auditável. */
  margemPercentagem: NetDecimal;
  valorUpfrontBruto: NetDecimal;
  valorUpfrontLiquido: NetDecimal;
}

export interface AcertoRecalculoAGravar {
  idTipoAcerto: typeof TiposAcerto.Recalculo;
  valorAntesBruto: NetDecimal;
  valorAntesLiquido: NetDecimal;
  valorDepoisBruto: NetDecimal;
  valorDepoisLiquido: NetDecimal;
  /** Zero: o valor novo já está nas linhas recriadas. */
  deltaBruto: NetDecimal;
  deltaLiquido: NetDecimal;
  motivo: string;
}

/**
 * Identidade de uma subscrição dentro do negócio, para reassociar a data de início ao
 * reprocessar: pelo número associado quando existe, senão pelo produto.
 */
export function chaveLinha(produtoId: number | null, numero: string | null): string {
  return numero !== null && !vazioOuEspacosNet(numero) ? `n:${trimNet(numero)}` : `p:${produtoId ?? ""}`;
}

export function prepararGravacaoUpfront(params: {
  linhas: readonly LinhaUpfrontCalculada[];
  /** As linhas que o negócio já tinha, pela ordem da consulta. */
  existentes: readonly LinhaUpfrontExistente[];
  /** Estado do negócio depois do upsert do cabeçalho (ATIVO se acabou de ser criado). */
  estadoNegocio: string;
  /** Data de início deal-level que veio no payload. */
  inicioContratoDoNegocio: DataCivil | null;
  margemUpfrontPct: NetDecimal | null;
  /** Se não-nulo e o dinheiro mudar, grava-se um acerto RECALCULO com este motivo. */
  motivoAcerto: string | null;
}): { linhas: LinhaUpfrontAGravar[]; acerto: AcertoRecalculoAGravar | null } {
  // A data de início é por linha e editável no painel: preserva-se a existente (a última
  // a aparecer ganha, como no C#); só as linhas sem data recebem a deal-level.
  const dataInicioPorLinha = new Map<string, DataCivil>();
  for (const a of params.existentes) {
    if (a.dataInicioContrato !== null) dataInicioPorLinha.set(chaveLinha(a.produtoId, a.numeroAssociado), a.dataInicioContrato);
  }

  // EM_VALIDACAO: a data deal-level (o won_time) não é o início do contrato; as linhas
  // sem data ficam sem data até à ativação.
  const dataInicioPorOmissao = params.estadoNegocio === EstadosNegocio.EmValidacao ? null : params.inicioContratoDoNegocio;
  const margemAplicada = params.margemUpfrontPct ?? NetDecimal.CEM;

  const linhas = params.linhas.map(
    (l): LinhaUpfrontAGravar => ({
      descricaoProduto: l.descricaoProduto,
      produtoId: l.produtoId,
      duracaoContrato: l.duracaoMeses,
      dataInicioContrato: dataInicioPorLinha.get(chaveLinha(l.produtoId, l.numeroAssociado)) ?? dataInicioPorOmissao,
      quantidade: l.quantidade,
      numeroAssociado: l.numeroAssociado,
      pricingPlanId: l.pricingPlanId,
      upfront: l.upfrontPlano,
      oferta: String(l.ofertaId),
      valorUnidade: l.valorUnidade,
      ajusteDuracao: l.ajusteDuracao,
      margemPercentagem: margemAplicada,
      valorUpfrontBruto: l.resultado.valorBruto,
      valorUpfrontLiquido: l.resultado.valorLiquido,
    }),
  );

  // Rasto do reprocessamento, só se o dinheiro mudou de facto (um webhook repetido com o
  // mesmo resultado não escreve nada, senão o histórico enchia-se de ruído).
  let acerto: AcertoRecalculoAGravar | null = null;
  if (params.motivoAcerto !== null) {
    let antesBruto = NetDecimal.ZERO;
    let antesLiquido = NetDecimal.ZERO;
    for (const a of params.existentes) {
      antesBruto = antesBruto.plus((a.valorUpfrontBruto ?? NetDecimal.ZERO).plus(a.premiosBruto ?? NetDecimal.ZERO));
      antesLiquido = antesLiquido.plus((a.valorUpfrontLiquido ?? NetDecimal.ZERO).plus(a.premiosLiquido ?? NetDecimal.ZERO));
    }
    const depoisBruto = NetDecimal.soma(params.linhas.map((l) => l.resultado.valorBruto));
    const depoisLiquido = NetDecimal.soma(params.linhas.map((l) => l.resultado.valorLiquido));

    if (!antesBruto.eq(depoisBruto) || !antesLiquido.eq(depoisLiquido)) {
      acerto = {
        idTipoAcerto: TiposAcerto.Recalculo,
        valorAntesBruto: antesBruto,
        valorAntesLiquido: antesLiquido,
        valorDepoisBruto: depoisBruto,
        valorDepoisLiquido: depoisLiquido,
        deltaBruto: NetDecimal.ZERO,
        deltaLiquido: NetDecimal.ZERO,
        motivo: params.motivoAcerto,
      };
    }
  }

  return { linhas, acerto };
}
