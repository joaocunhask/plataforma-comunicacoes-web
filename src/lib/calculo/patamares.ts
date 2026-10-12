// Patamares de margem do upfront: o comercial recebe uma % do bruto que sobe por degraus
// conforme o bruto acumulado no período (mês, trimestre ou ano civil).
//
// Port fiel de Shared/Patamares (PatamarResolver, PatamarMargemPlanner, PatamarFechoPlanner,
// PlanoMargensComercial) e da parte sem I/O de PatamaresService e PatamaresFechoService.
//
// ATENÇÃO às duas semânticas de margem, que são opostas:
//   · cfg_margens.margem_percentagem      = % que o PARCEIRO retém → líquido = bruto × (1 − m/100)
//   · percentagem_comercial dos patamares = % que o COMERCIAL recebe → líquido = bruto × m/100

import { agrupar, mapaUnico } from "./colecoes";
import { type DataCivil, diasNoMes, montarData, partesDaData } from "./datas";
import { NetDecimal } from "./decimal-net";
import { contaParaCalculos } from "./estados-negocio";
import { toUpperInvariantNet, trimNet, tryParseIntNet, vazioNet } from "./texto-net";

export type TipoPeriodoPatamar = "MENSAL" | "TRIMESTRAL" | "ANUAL";

/** Período fechado [inicio, fim], ambos inclusive. */
export interface Periodo {
  inicio: DataCivil;
  fim: DataCivil;
}

/** Um degrau da escada de um comercial numa operadora. */
export interface PatamarEscalao {
  ordem: number;
  limiteInferior: NetDecimal;
  percentagemComercial: NetDecimal;
}

/** Uma linha reduzida ao que os patamares precisam. */
export interface LinhaBrutoPeriodo {
  dataInicioContrato: DataCivil;
  valorUpfrontBruto: NetDecimal;
}

// ─── PatamarResolver ─────────────────────────────────────────────────────────

/** Converte cfg_patamar_config.tipo_periodo (ignora maiúsculas e espaços, como o C#). */
export function parseTipoPeriodo(codigo: string | null): TipoPeriodoPatamar {
  const normalizado = codigo === null ? null : toUpperInvariantNet(trimNet(codigo));
  if (normalizado === "MENSAL" || normalizado === "TRIMESTRAL" || normalizado === "ANUAL") return normalizado;
  throw new RangeError(`tipo_periodo inválido: '${codigo}'.`);
}

/** O período civil a que uma data pertence. */
export function balde(data: DataCivil, tipo: TipoPeriodoPatamar): Periodo {
  const { ano, mes } = partesDaData(data);
  switch (tipo) {
    case "MENSAL":
      return { inicio: montarData(ano, mes, 1), fim: montarData(ano, mes, diasNoMes(ano, mes)) };
    case "TRIMESTRAL": {
      const mesInicio = Math.floor((mes - 1) / 3) * 3 + 1; // 1, 4, 7, 10
      return { inicio: montarData(ano, mesInicio, 1), fim: montarData(ano, mesInicio + 2, diasNoMes(ano, mesInicio + 2)) };
    }
    case "ANUAL":
      return { inicio: montarData(ano, 1, 1), fim: montarData(ano, 12, 31) };
  }
}

/**
 * O degrau atingido por um acumulado (CLIFF): o de maior limite ≤ acumulado. Com escada,
 * um acumulado ABAIXO do primeiro degrau devolve o PRIMEIRO degrau — o patamar é o chão
 * da margem, nunca a margem base. Só devolve null se não houver degraus.
 * Empates de limite (config incoerente): maior ordem no cliff, menor ordem no chão.
 */
export function resolverPatamar(escaloes: Iterable<PatamarEscalao>, acumulado: NetDecimal): PatamarEscalao | null {
  let cliff: PatamarEscalao | null = null;
  let primeiro: PatamarEscalao | null = null;
  for (const e of escaloes) {
    if (
      primeiro === null ||
      e.limiteInferior.lt(primeiro.limiteInferior) ||
      (e.limiteInferior.eq(primeiro.limiteInferior) && e.ordem < primeiro.ordem)
    ) {
      primeiro = e;
    }
    if (e.limiteInferior.gt(acumulado)) continue;
    if (
      cliff === null ||
      e.limiteInferior.gt(cliff.limiteInferior) ||
      (e.limiteInferior.eq(cliff.limiteInferior) && e.ordem > cliff.ordem)
    ) {
      cliff = e;
    }
  }
  return cliff ?? primeiro;
}

/** A percentagem do degrau atingido, ou null se não houver escada. */
export function resolverPercentagem(escaloes: Iterable<PatamarEscalao>, acumulado: NetDecimal): NetDecimal | null {
  return resolverPatamar(escaloes, acumulado)?.percentagemComercial ?? null;
}

// ─── PatamarMargemPlanner ────────────────────────────────────────────────────

/** A margem decidida para um período do comercial. */
export interface PatamarMargemPeriodo {
  periodo: Periodo;
  /** Σ valor_upfront_bruto das linhas do período. */
  acumulado: NetDecimal;
  /** % que o comercial recebe; null = sem patamar (usa-se o líquido guardado). */
  margem: NetDecimal | null;
  /** O período já terminou (usa a margem congelada do histórico). */
  fechado: boolean;
}

/** Margens de patamar de um comercial numa operadora, por início de período. */
export class PlanoMargens {
  constructor(
    readonly tipo: TipoPeriodoPatamar,
    /** Por início de período, pela ordem em que os períodos apareceram nas linhas. */
    readonly porPeriodo: ReadonlyMap<DataCivil, PatamarMargemPeriodo>,
  ) {}

  /** A margem do período do início de contrato, ou null (sem patamar → líquido guardado). */
  margemPara(dataInicioContrato: DataCivil): NetDecimal | null {
    return this.porPeriodo.get(balde(dataInicioContrato, this.tipo).inicio)?.margem ?? null;
  }
}

/** Agrupa por período civil e soma o bruto, pela ordem de primeira ocorrência. */
function acumularPorPeriodo(
  linhas: Iterable<LinhaBrutoPeriodo>,
  tipo: TipoPeriodoPatamar,
): Map<DataCivil, { periodo: Periodo; acumulado: NetDecimal }> {
  const porPeriodo = new Map<DataCivil, { periodo: Periodo; acumulado: NetDecimal }>();
  for (const linha of linhas) {
    const periodo = balde(linha.dataInicioContrato, tipo);
    const atual = porPeriodo.get(periodo.inicio);
    if (atual) atual.acumulado = atual.acumulado.plus(linha.valorUpfrontBruto);
    else porPeriodo.set(periodo.inicio, { periodo, acumulado: linha.valorUpfrontBruto });
  }
  return porPeriodo;
}

/**
 * Decide a margem de cada período do comercial: AO VIVO se o período está aberto
 * (degrau pelo acumulado), do HISTÓRICO se já fechou (margem congelada no fecho).
 */
export function planearMargens(
  linhas: Iterable<LinhaBrutoPeriodo>,
  tipo: TipoPeriodoPatamar,
  escaloes: readonly PatamarEscalao[],
  carimbos: ReadonlyMap<DataCivil, NetDecimal>,
  hoje: DataCivil,
): PlanoMargens {
  const resultado = new Map<DataCivil, PatamarMargemPeriodo>();
  for (const [inicio, g] of acumularPorPeriodo(linhas, tipo)) {
    const fechado = g.periodo.fim < hoje;
    const margem = fechado
      ? (carimbos.get(inicio) ?? null) // fechado sem carimbo → null (não se re-deriva o passado)
      : resolverPercentagem(escaloes, g.acumulado);
    resultado.set(inicio, { periodo: g.periodo, acumulado: g.acumulado, margem, fechado });
  }
  return new PlanoMargens(tipo, resultado);
}

// ─── PatamarFechoPlanner ─────────────────────────────────────────────────────

/** Um carimbo a criar em sys_patamar_atingido: o patamar atingido num período fechado. */
export interface CarimboAFazer {
  periodo: Periodo;
  acumulado: NetDecimal;
  ordem: number;
  percentagemComercial: NetDecimal;
}

/**
 * Que períodos JÁ FECHADOS ainda não têm carimbo, e com que patamar. Só a partir de
 * `desde` (nunca congela história anterior à config), nunca duplica, e só com escada.
 */
export function planearFecho(
  linhas: Iterable<LinhaBrutoPeriodo>,
  tipo: TipoPeriodoPatamar,
  escaloes: readonly PatamarEscalao[],
  jaCarimbados: ReadonlySet<DataCivil>,
  hoje: DataCivil,
  desde: DataCivil,
): CarimboAFazer[] {
  const resultado: CarimboAFazer[] = [];
  for (const [inicio, g] of acumularPorPeriodo(linhas, tipo)) {
    if (inicio < desde) continue; // antes da config existir
    if (g.periodo.fim >= hoje) continue; // ainda aberto
    if (jaCarimbados.has(inicio)) continue; // já fechado antes

    const escalao = resolverPatamar(escaloes, g.acumulado);
    if (escalao === null) continue; // sem escada → não carimba

    resultado.push({
      periodo: g.periodo,
      acumulado: g.acumulado,
      ordem: escalao.ordem,
      percentagemComercial: escalao.percentagemComercial,
    });
  }
  return resultado;
}

// ─── PlanoMargensComercial (PatamaresService) ────────────────────────────────

/** Uma linha de cálculo do comercial, reduzida ao que os patamares precisam. */
export interface LinhaPatamarInput {
  operadoraId: number;
  dataInicioContrato: DataCivil | null;
  valorUpfrontBruto: NetDecimal;
}

/**
 * As margens de patamar de um comercial, por operadora. Sem patamares na empresa,
 * `ativo` é false e `margemPara` devolve sempre null (usa-se o líquido guardado).
 */
export class PlanoMargensComercial {
  static readonly INATIVO = new PlanoMargensComercial(false, new Map(), "MENSAL", new Map());

  constructor(
    readonly ativo: boolean,
    readonly porOperadora: ReadonlyMap<number, PlanoMargens>,
    /** Período de reset (para o período corrente mesmo sem negócios). */
    readonly tipo: TipoPeriodoPatamar,
    /** Degraus ativos por operadora — para o portal mostrar o progresso. */
    readonly escadaPorOperadora: ReadonlyMap<number, readonly PatamarEscalao[]>,
  ) {}

  margemPara(operadoraId: number, dataInicioContrato: DataCivil): NetDecimal | null {
    return this.porOperadora.get(operadoraId)?.margemPara(dataInicioContrato) ?? null;
  }
}

export interface ConfigPatamares {
  ativo: boolean;
  /** cfg_patamar_config.tipo_periodo. */
  tipoPeriodo: string;
  /** cfg_patamar_config.vigente_desde. */
  vigenteDesde: DataCivil | null;
  /** Dia de cfg_patamar_config.criado_em (retrocompat quando não há vigente_desde). */
  criadoEm: DataCivil;
}

export interface EscalaoDoComercial extends PatamarEscalao {
  operadoraId: number;
}

export interface CarimboExistente {
  operadoraId: number;
  periodoInicio: DataCivil;
  percentagemComercial: NetDecimal;
}

/**
 * PatamaresService.PlanearAsync sem a BD: recebe a config da empresa, os degraus ATIVOS
 * do comercial, os seus carimbos e as linhas, e devolve o plano a consultar linha a linha.
 */
export function planearMargensDoComercial(params: {
  config: ConfigPatamares | null;
  escaloesAtivos: readonly EscalaoDoComercial[];
  carimbos: readonly CarimboExistente[];
  linhas: readonly LinhaPatamarInput[];
  hoje: DataCivil;
}): PlanoMargensComercial {
  const { config } = params;
  if (config === null || !config.ativo) return PlanoMargensComercial.INATIVO;
  const tipo = parseTipoPeriodo(config.tipoPeriodo);

  const escaloesPorOperadora = agrupar(params.escaloesAtivos, (e) => e.operadoraId, (e) => ({
    ordem: e.ordem,
    limiteInferior: e.limiteInferior,
    percentagemComercial: e.percentagemComercial,
  }));

  const carimbosPorOperadora = new Map<number, Map<DataCivil, NetDecimal>>();
  for (const c of params.carimbos) {
    let porInicio = carimbosPorOperadora.get(c.operadoraId);
    if (!porInicio) carimbosPorOperadora.set(c.operadoraId, (porInicio = new Map()));
    if (!porInicio.has(c.periodoInicio)) porInicio.set(c.periodoInicio, c.percentagemComercial); // o primeiro ganha
  }

  // Um plano por operadora presente nas linhas (só as com início de contrato).
  const linhasPorOperadora = agrupar(
    params.linhas.filter((l): l is LinhaPatamarInput & { dataInicioContrato: DataCivil } => l.dataInicioContrato !== null),
    (l) => l.operadoraId,
    (l) => ({ dataInicioContrato: l.dataInicioContrato, valorUpfrontBruto: l.valorUpfrontBruto }),
  );
  const planos = new Map<number, PlanoMargens>();
  for (const [operadoraId, linhasOp] of linhasPorOperadora) {
    planos.set(
      operadoraId,
      planearMargens(
        linhasOp,
        tipo,
        escaloesPorOperadora.get(operadoraId) ?? [],
        carimbosPorOperadora.get(operadoraId) ?? new Map(),
        params.hoje,
      ),
    );
  }

  return new PlanoMargensComercial(true, planos, tipo, escaloesPorOperadora);
}

/** Líquido do comercial com a margem de patamar (% que o comercial recebe), a 2 casas. */
export function aplicarMargemDoComercial(bruto: NetDecimal, margem: NetDecimal): NetDecimal {
  return bruto.times(margem).div(NetDecimal.CEM).round(2);
}

/**
 * O líquido de upfront que se MOSTRA (portal, painel): com patamar, bruto × margem/100;
 * sem patamar (plano inativo, linha sem data, ou período sem margem), o líquido guardado.
 */
export function liquidoUpfrontExibido(
  linha: {
    operadoraId: number;
    dataInicioContrato: DataCivil | null;
    valorUpfrontBruto: NetDecimal | null;
    valorUpfrontLiquido: NetDecimal | null;
  },
  plano: PlanoMargensComercial | null,
): NetDecimal {
  const guardado = linha.valorUpfrontLiquido ?? NetDecimal.ZERO;
  if (plano === null || !plano.ativo || linha.dataInicioContrato === null) return guardado;
  const margem = plano.margemPara(linha.operadoraId, linha.dataInicioContrato);
  return margem === null ? guardado : aplicarMargemDoComercial(linha.valorUpfrontBruto ?? NetDecimal.ZERO, margem);
}

// ─── Fecho de período (PatamaresFechoService) ────────────────────────────────

export interface EscalaoAtivoDaEmpresa extends PatamarEscalao {
  id: number;
  aspnetUserId: string;
  operadoraId: number;
}

export interface LinhaParaFecho {
  idComercial: number | null;
  estadoNegocio: string;
  operadoraId: number;
  dataInicioContrato: DataCivil | null;
  valorUpfrontBruto: NetDecimal | null;
}

export interface CarimboNovo {
  aspnetUserId: string;
  operadoraId: number;
  periodo: Periodo;
  percentagemComercial: NetDecimal;
  /** cfg_patamar_escalao.id do degrau, quando ainda existe. */
  idPatamar: number | null;
  brutoAcumulado: NetDecimal;
}

/**
 * PatamaresFechoService.FecharEmpresaAsync sem a BD: os carimbos a gravar numa empresa.
 * Pela ordem do C# (comerciais pela primeira linha em que aparecem, depois períodos).
 */
export function planearFechoDaEmpresa(params: {
  config: ConfigPatamares | null;
  escaloesAtivos: readonly EscalaoAtivoDaEmpresa[];
  membros: readonly { idCrm: string | null; aspnetUserId: string }[];
  linhas: readonly LinhaParaFecho[];
  carimbados: readonly { aspnetUserId: string; operadoraId: number; periodoInicio: DataCivil }[];
  hoje: DataCivil;
}): CarimboNovo[] {
  const { config } = params;
  if (config === null || !config.ativo) return [];
  const tipo = parseTipoPeriodo(config.tipoPeriodo);
  // Nunca carimba antes da fronteira de ativação (vigente_desde; sem ela, criado_em).
  const desde = balde(config.vigenteDesde ?? config.criadoEm, tipo).inicio;

  if (params.escaloesAtivos.length === 0) return [];

  const chave = (userId: string, operadoraId: number) => `${userId}\u0000${operadoraId}`;
  const escaloesPorChave = agrupar(params.escaloesAtivos, (e) => chave(e.aspnetUserId, e.operadoraId), (e) => ({
    ordem: e.ordem,
    limiteInferior: e.limiteInferior,
    percentagemComercial: e.percentagemComercial,
  }));
  const idPatamarPorOrdem = mapaUnico(
    params.escaloesAtivos,
    (e) => `${chave(e.aspnetUserId, e.operadoraId)}\u0000${e.ordem}`,
    (e) => e.id,
  );
  const crmParaUser = mapaUnico(
    params.membros.flatMap((m) => {
      if (vazioNet(m.idCrm)) return [];
      const idCrm = tryParseIntNet(m.idCrm);
      return idCrm === null ? [] : [{ idCrm, aspnetUserId: m.aspnetUserId }];
    }),
    (m) => m.idCrm,
    (m) => m.aspnetUserId,
  );

  const carimbadosPorChave = new Map<string, Set<DataCivil>>();
  for (const c of params.carimbados) {
    const k = chave(c.aspnetUserId, c.operadoraId);
    let set = carimbadosPorChave.get(k);
    if (!set) carimbadosPorChave.set(k, (set = new Set()));
    set.add(c.periodoInicio);
  }

  // Só ATIVO/PROCESSADO, com data e comercial; agrupadas por (comercial, operadora) com escada.
  const linhasPorChave = new Map<string, { userId: string; operadoraId: number; linhas: LinhaBrutoPeriodo[] }>();
  for (const l of params.linhas) {
    if (l.dataInicioContrato === null || l.idComercial === null || !contaParaCalculos(l.estadoNegocio)) continue;
    const userId = crmParaUser.get(l.idComercial);
    if (userId === undefined) continue;
    const k = chave(userId, l.operadoraId);
    if (!escaloesPorChave.has(k)) continue;
    let grupo = linhasPorChave.get(k);
    if (!grupo) linhasPorChave.set(k, (grupo = { userId, operadoraId: l.operadoraId, linhas: [] }));
    grupo.linhas.push({ dataInicioContrato: l.dataInicioContrato, valorUpfrontBruto: l.valorUpfrontBruto ?? NetDecimal.ZERO });
  }

  const novos: CarimboNovo[] = [];
  for (const [k, grupo] of linhasPorChave) {
    const aFazer = planearFecho(
      grupo.linhas,
      tipo,
      escaloesPorChave.get(k) ?? [],
      carimbadosPorChave.get(k) ?? new Set(),
      params.hoje,
      desde,
    );
    for (const c of aFazer) {
      novos.push({
        aspnetUserId: grupo.userId,
        operadoraId: grupo.operadoraId,
        periodo: c.periodo,
        percentagemComercial: c.percentagemComercial,
        idPatamar: idPatamarPorOrdem.get(`${k}\u0000${c.ordem}`) ?? null,
        brutoAcumulado: c.acumulado,
      });
    }
  }
  return novos;
}
