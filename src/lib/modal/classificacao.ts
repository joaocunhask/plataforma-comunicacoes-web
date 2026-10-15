// Diz, para cada produto, se pertence ao funil do negócio onde o modal está aberto — e, se
// não, a que funil pertence. Port de API/Services/FunilClassificacaoService.cs.
//
// Degrada com elegância, de propósito: funil por mapear, objetivo sem linha de atingimento,
// ou catálogo sem atingimentos → a classificação desliga-se e o modal funciona como sempre.
import "server-only";

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db as dbPorOmissao, type Executor } from "@/db";
import { refFunilExcecoes, refObjetivos, refProdutosVodafone } from "@/db/schema";
import {
  aplicarExcecoes,
  atingimentoDoProduto,
  pertenceAoFunil,
  resolverFunis,
  TiposReceita,
  type ExcecaoFunil,
  type ObjetivoFunil,
} from "./funis";

export type EstadoClassificacao = "pertence" | "outro_funil" | "nao_classificado";

export interface FunilAlvo {
  idFunil: number;
  objetivo: string | null;
  nomeFunil: string | null;
  /** Do tipo de receita do negócio de origem: o palpite por omissão do seletor. */
  sugerido: boolean;
}

export interface ClassificacaoLinha {
  estado: EstadoClassificacao;
  linhaProduto: string | null;
  atingimento: string | null;
  alvos: FunilAlvo[];
  /** Pertence a este funil só por uma exceção registada pela Brasfone. */
  porExcecao: boolean;
}

export interface ResultadoClassificacao {
  ativa: boolean;
  motivoInativa: string | null;
  nomeObjetivoDoNegocio: string | null;
  porPpid: Map<string, ClassificacaoLinha>;
}

const inativa = (motivo: string): ResultadoClassificacao => ({ ativa: false, motivoInativa: motivo, nomeObjetivoDoNegocio: null, porPpid: new Map() });

export async function classificar(
  empresaId: number,
  funilDoNegocio: number | null,
  ppids: readonly (string | null)[],
  db: Executor = dbPorOmissao,
): Promise<ResultadoClassificacao> {
  if (funilDoNegocio === null) return inativa("Negócio sem funil identificado.");

  const objetivos = await db
    .select({
      id: refObjetivos.id,
      funil: refObjetivos.idFunilPipedrive,
      nome: refObjetivos.nome,
      nomeFunil: refObjetivos.nomeFunilPipedrive,
      atingimentoLinha: refObjetivos.atingimentoLinha,
      idTipoReceita: refObjetivos.idTipoReceita,
    })
    .from(refObjetivos)
    .where(and(eq(refObjetivos.empresaId, empresaId), isNotNull(refObjetivos.idFunilPipedrive)));

  const doNegocio = objetivos.find((o) => o.funil === funilDoNegocio);
  if (!doNegocio) return inativa("O funil deste negócio não está mapeado a nenhum objetivo.");
  if (!doNegocio.atingimentoLinha?.trim() || doNegocio.idTipoReceita === null)
    return inativa("O objetivo deste funil ainda não tem linha de atingimento configurada.");

  const vista: ObjetivoFunil[] = objetivos.map((o) => ({
    objetivoId: o.id,
    idFunilPipedrive: o.funil!,
    nomeFunil: o.nomeFunil,
    atingimentoLinha: o.atingimentoLinha,
    idTipoReceita: o.idTipoReceita,
  }));
  const objetivoDoNegocio = vista.find((o) => o.idFunilPipedrive === funilDoNegocio)!;
  const nomePorObjetivo = new Map(objetivos.map((o) => [o.id, o.nome]));

  const distintos = [...new Set(ppids.filter((p): p is string => !!p && !!p.trim()))];
  const produtos =
    distintos.length === 0
      ? []
      : await db
          .select({
            ppid: refProdutosVodafone.pricingPlanId,
            linhaProduto: refProdutosVodafone.linhaProduto,
            areaProduto: refProdutosVodafone.areaProduto,
            subareaProduto: refProdutosVodafone.subareaProduto,
            nova: refProdutosVodafone.atingimentoNova,
            refid: refProdutosVodafone.atingimentoRefid,
          })
          .from(refProdutosVodafone)
          .where(inArray(refProdutosVodafone.pricingPlanId, distintos));

  const excecoes: ExcecaoFunil[] =
    produtos.length === 0
      ? []
      : await db
          .select({
            criterio: refFunilExcecoes.criterio,
            valor: refFunilExcecoes.valor,
            idTipoReceita: refFunilExcecoes.idTipoReceita,
            atingimentoLinha: refFunilExcecoes.atingimentoLinha,
          })
          .from(refFunilExcecoes)
          .where(eq(refFunilExcecoes.ativo, true));

  const porPpid = new Map<string, ClassificacaoLinha>();
  let semDados = 0;
  for (const ppid of distintos) {
    const prod = produtos.find((p) => p.ppid === ppid);

    // O atingimento já com as exceções, nos dois tipos de receita (os alvos consideram ambos).
    let nova = prod?.nova ?? null;
    let refid = prod?.refid ?? null;
    if (prod && excecoes.length > 0) {
      const pc = { pricingPlanId: prod.ppid, linhaProduto: prod.linhaProduto, areaProduto: prod.areaProduto, subareaProduto: prod.subareaProduto };
      nova = aplicarExcecoes(prod.nova, TiposReceita.NovaReceita, pc, excecoes).atingimento;
      refid = aplicarExcecoes(prod.refid, TiposReceita.Refidelizacao, pc, excecoes).atingimento;
    }

    const atingimento = prod ? atingimentoDoProduto(objetivoDoNegocio.idTipoReceita, nova, refid) : null;
    if (!atingimento?.trim()) {
      semDados++;
      porPpid.set(ppid, { estado: "nao_classificado", linhaProduto: prod?.linhaProduto ?? null, atingimento: null, alvos: [], porExcecao: false });
      continue;
    }

    const pertence = pertenceAoFunil(nova, refid, objetivoDoNegocio);
    const porExcecao = pertence && !pertenceAoFunil(prod!.nova, prod!.refid, objetivoDoNegocio);
    // Num Pacote Convergente vêm DOIS funis: "vale em qualquer um", nunca "pôr nos dois".
    const alvos = pertence ? [] : construirAlvos(nova, refid, objetivoDoNegocio.idTipoReceita, vista, nomePorObjetivo);
    porPpid.set(ppid, { estado: pertence ? "pertence" : "outro_funil", linhaProduto: prod!.linhaProduto, atingimento, alvos, porExcecao });
  }

  // Nenhum produto com atingimento: o catálogo ainda não foi recarregado com as colunas novas.
  if (distintos.length > 0 && semDados === distintos.length) {
    console.info(`Classificação de funil inativa (empresa ${empresaId}): nenhum dos ${distintos.length} produtos tem linha de atingimento.`);
    return inativa("O catálogo ainda não tem as linhas de atingimento carregadas.");
  }
  return { ativa: true, motivoInativa: null, nomeObjetivoDoNegocio: doNegocio.nome, porPpid };
}

/**
 * Os funis onde a linha pode ser posta, nos DOIS tipos de receita (cada tipo lê a sua coluna
 * de atingimento, e elas divergem). Os do tipo do negócio vêm sugeridos e primeiro.
 */
function construirAlvos(
  nova: string | null,
  refid: string | null,
  tipoDoNegocio: number | null,
  vista: readonly ObjetivoFunil[],
  nomePorObjetivo: ReadonlyMap<number, string | null>,
): FunilAlvo[] {
  const porFunil = new Map<number, FunilAlvo>();
  for (const tipo of [TiposReceita.NovaReceita, TiposReceita.Refidelizacao]) {
    for (const o of resolverFunis(atingimentoDoProduto(tipo, nova, refid), tipo, vista)) {
      if (porFunil.get(o.idFunilPipedrive)?.sugerido) continue; // não despromove
      porFunil.set(o.idFunilPipedrive, {
        idFunil: o.idFunilPipedrive,
        objetivo: nomePorObjetivo.get(o.objetivoId) ?? null,
        nomeFunil: o.nomeFunil,
        sugerido: tipo === tipoDoNegocio,
      });
    }
  }
  return [...porFunil.values()].sort((a, b) => Number(b.sugerido) - Number(a.sugerido) || a.idFunil - b.idFunil);
}
