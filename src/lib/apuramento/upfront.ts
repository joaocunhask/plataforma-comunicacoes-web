// Apuramento do upfront de um negócio ganho: lê a configuração da empresa e o negócio no
// Pipedrive, chama o motor (src/lib/calculo) e grava tudo numa transação.
// Port de API/Services/UpfrontApuramentoService.cs (ApurarAsync).
import "server-only";

import { and, asc, eq } from "drizzle-orm";
import { db as dbPorOmissao, type Executor } from "@/db";
import {
  cfgMargens,
  orgEmpresaOfertaPipedrive,
  orgEmpresaPipedriveFieldMap,
  orgEmpresas,
  orgMembros,
  refAjusteComissaoVodafone,
  refObjetivos,
  refOperadoras,
  refPlanoComissionalVodafone,
  sysCalculoComissoes,
  sysLogErros,
  sysNegocioAcertos,
  sysNegocios,
} from "@/db/schema";
import {
  calcularLinhasUpfront,
  dataCivil,
  EstadosNegocio,
  lerCampoDoNegocio,
  NetDecimal,
  prepararGravacaoUpfront,
  produtosQuePrecisamDeDetalhes,
  verificarEstadoParaReprocessar,
  type AvisoUpfront,
  type DetalhesProduto,
} from "@/lib/calculo";
import { apiPipedrive, campoComoTexto, donoDoNegocio, type ApiPipedrive, type Credencial } from "@/lib/pipedrive/cliente";
import type { EntradaUpfront } from "@/lib/pipedrive/webhooks";

const VODAFONE = "Vodafone";
const FLUXO_LOG = "Calculo Upfront - [VODAFONE]";

export type ResultadoUpfront =
  | { ok: true; ignorado: false; linhasCriadas: number; linhasSemCalculo: number }
  | { ok: true; ignorado: true; motivo: string }
  | { ok: false; statusCode: number; mensagem: string };

const falha = (mensagem: string, statusCode = 500): ResultadoUpfront => ({ ok: false, statusCode, mensagem });
const dec = (v: string | null) => NetDecimal.deOuNull(v);

export interface OpcoesUpfront {
  /** Se não-nulo e o dinheiro mudar, grava um acerto RECALCULO com este motivo. */
  motivoAcerto?: string | null;
  /** Autor do acerto; nulo no webhook (não é uma pessoa). */
  userIdAcerto?: string | null;
  /** Para os testes: a BD (ou uma transação) e a API do Pipedrive. */
  db?: Executor;
  pipedrive?: ApiPipedrive;
}

export async function apurarUpfront(
  entrada: EntradaUpfront,
  empresaId: number,
  opcoes: OpcoesUpfront = {},
): Promise<ResultadoUpfront> {
  const db = opcoes.db ?? dbPorOmissao;
  const pd = opcoes.pipedrive ?? apiPipedrive;

  // 1. Empresa e mapa de campos do Pipedrive
  const [empresa] = await db
    .select({ id: orgEmpresas.id, apiToken: orgEmpresas.pipedriveApiToken })
    .from(orgEmpresas)
    .where(and(eq(orgEmpresas.id, empresaId), eq(orgEmpresas.ativo, true)));
  if (!empresa) return falha("Empresa não encontrada ou inativa.");
  if (!empresa.apiToken?.trim()) return falha("Empresa sem pipedrive_api_token configurado.");
  const cred: Credencial = { tipo: "api-token", token: empresa.apiToken };

  const mapa = new Map(
    (
      await db
        .select({ chave: orgEmpresaPipedriveFieldMap.chaveLogica, key: orgEmpresaPipedriveFieldMap.pipedriveFieldKey })
        .from(orgEmpresaPipedriveFieldMap)
        .where(eq(orgEmpresaPipedriveFieldMap.empresaId, empresaId))
    ).map((m) => [m.chave, m.key]),
  );
  const classificacaoKey = mapa.get("classificacao_oferta") ?? null;
  const ppidKey = mapa.get("pricing_plan_id") ?? null;
  const oportunidadeKey = mapa.get("oportunidade") ?? null;
  const idSimuladorKey = mapa.get("id_simulador") ?? null;
  if (!classificacaoKey?.trim())
    return falha("Campo 'classificacao_oferta' não configurado no mapa de campos (admin → Configurações → Campos de produto).");

  // 2. Operadora
  const [operadora] = await db
    .select({ id: refOperadoras.id })
    .from(refOperadoras)
    .where(eq(refOperadoras.nome, VODAFONE))
    .orderBy(asc(refOperadoras.id))
    .limit(1);
  if (!operadora) return falha("Operadora Vodafone não configurada.");
  const operadoraId = operadora.id;

  // 3. Comercial (id_crm → utilizador)
  const [comercial] = await db
    .select({ userId: orgMembros.aspnetUserId })
    .from(orgMembros)
    .where(
      and(
        eq(orgMembros.empresaId, empresaId),
        eq(orgMembros.idCrm, String(entrada.idComercial)),
        eq(orgMembros.bloqueado, false),
      ),
    )
    .orderBy(asc(orgMembros.id))
    .limit(1);
  if (!comercial) return falha(`Comercial com id_crm=${entrada.idComercial} não encontrado ou bloqueado.`);

  // 4. Objetivo do funil → tipo de receita. Funil não mapeado não é nosso: ignora-se.
  const [objetivo] = await db
    .select({ id: refObjetivos.id, idTipoReceita: refObjetivos.idTipoReceita })
    .from(refObjetivos)
    .where(
      and(
        eq(refObjetivos.empresaId, empresaId),
        eq(refObjetivos.operadoraId, operadoraId),
        eq(refObjetivos.idFunilPipedrive, entrada.idFunil),
      ),
    )
    .orderBy(asc(refObjetivos.id))
    .limit(1);
  if (!objetivo || objetivo.idTipoReceita === null) {
    console.info(`Webhook ignorado | Empresa ${empresaId} | Deal ${entrada.idNegocio} | funil ${entrada.idFunil} não mapeado a objetivo.`);
    return { ok: true, ignorado: true, motivo: `Funil ${entrada.idFunil} não configurado — negócio ignorado (não processado).` };
  }
  const idTipoReceita = objetivo.idTipoReceita;

  // 5–7. Margem, ajustes de duração, ofertas e plano comissional
  const [margem] = await db
    .select({ pct: cfgMargens.margemPercentagem })
    .from(cfgMargens)
    .where(
      and(
        eq(cfgMargens.empresaId, empresaId),
        eq(cfgMargens.operadoraId, operadoraId),
        eq(cfgMargens.aspnetUserId, comercial.userId),
        eq(cfgMargens.tipo, "upfront"),
        eq(cfgMargens.ativo, true),
      ),
    )
    .orderBy(asc(cfgMargens.id))
    .limit(1);
  const margemUpfrontPct = margem ? dec(margem.pct) : null;

  const ajustesDuracao = (
    await db
      .select()
      .from(refAjusteComissaoVodafone)
      .where(eq(refAjusteComissaoVodafone.empresaId, empresaId))
      .orderBy(asc(refAjusteComissaoVodafone.id))
  ).map((a) => ({ duracaoMin: a.duracaoMin, duracaoMax: a.duracaoMax, ajuste: NetDecimal.de(a.ajuste) }));

  const ofertaPorOption = new Map(
    (
      await db
        .select({ option: orgEmpresaOfertaPipedrive.pipedriveOptionId, oferta: orgEmpresaOfertaPipedrive.ofertaId })
        .from(orgEmpresaOfertaPipedrive)
        .where(eq(orgEmpresaOfertaPipedrive.empresaId, empresaId))
    ).map((x) => [x.option, x.oferta]),
  );

  const planoPorOferta = new Map(
    (
      await db
        .select({ oferta: refPlanoComissionalVodafone.oferta, upfront: refPlanoComissionalVodafone.upfront })
        .from(refPlanoComissionalVodafone)
        .where(
          and(
            eq(refPlanoComissionalVodafone.empresaId, empresaId),
            eq(refPlanoComissionalVodafone.objetivosAtingidos, 0),
            eq(refPlanoComissionalVodafone.tipoReceita, idTipoReceita),
          ),
        )
    ).map((p) => [p.oferta, NetDecimal.de(p.upfront)]),
  );

  // 8. Pipedrive: produtos do negócio, detalhes dos que têm subscrições e, se mapeados,
  //    os campos deal-level (fonte única = o custom field do negócio, com fallback ao payload).
  const produtos = await pd.obterProdutosDoNegocio(entrada.idNegocio, cred);
  if (produtos.length === 0) console.warn(`Deal ${entrada.idNegocio} sem produtos no Pipedrive.`);

  const negocioPd =
    oportunidadeKey !== null || idSimuladorKey !== null ? await pd.obterNegocio(entrada.idNegocio, cred) : null;
  const lerDoNegocio = (key: string | null) =>
    negocioPd && key?.trim() ? lerCampoDoNegocio(campoComoTexto(negocioPd, key)) : null;
  const oportunidade = lerDoNegocio(oportunidadeKey) ?? entrada.oportunidade;
  const idSimulador = lerDoNegocio(idSimuladorKey) ?? entrada.idSimulador;

  // O id_comercial vem de quem chama o webhook; se divergir do dono real, fica registado.
  const dono = negocioPd ? donoDoNegocio(negocioPd) : null;
  if (dono !== null && dono !== entrada.idComercial)
    console.warn(
      `Divergência de dono | Empresa ${empresaId} | Deal ${entrada.idNegocio} | id_comercial do payload=${entrada.idComercial} ` +
        `mas o dono no Pipedrive é ${dono}. A comissão vai para o do payload — confirmar se foi mudança legítima de dono.`,
    );
  if (!ppidKey?.trim()) console.info(`Campo 'pricing_plan_id' não configurado (empresa ${empresaId}); pricing_plan_id fica nulo.`);

  const detalhes = new Map<number, DetalhesProduto | null>();
  for (const produtoId of produtosQuePrecisamDeDetalhes(
    produtos.map((p) => ({ produtoId: p.produtoId, nome: p.nome, precoUnitario: p.precoUnitario, observacoes: p.observacoes })),
  )) {
    const p = await pd.obterProduto(produtoId, cred);
    detalhes.set(
      produtoId,
      p && {
        classificacaoOferta: campoComoTexto(p, classificacaoKey),
        pricingPlanId: ppidKey?.trim() ? campoComoTexto(p, ppidKey) : null,
      },
    );
  }

  // 9. Motor
  const { linhas, linhasSemCalculo, avisos } = calcularLinhasUpfront(
    produtos.map((p) => ({ produtoId: p.produtoId, nome: p.nome, precoUnitario: p.precoUnitario, observacoes: p.observacoes })),
    detalhes,
    { ofertaPorOption, planoPorOferta, ajustesDuracao, margemUpfrontPct },
  );
  for (const a of avisos) console.warn(`Upfront deal ${entrada.idNegocio}: ${descreverAviso(a)}`);

  // 10. Gravar, numa transação
  return db.transaction(async (tx) => {
    const [existente] = await tx
      .select({ id: sysNegocios.id, estado: sysNegocios.estado })
      .from(sysNegocios)
      .where(and(eq(sysNegocios.idNegocio, entrada.idNegocio), eq(sysNegocios.empresaId, empresaId)))
      .for("update");

    const bloqueio = verificarEstadoParaReprocessar(existente?.estado ?? null, entrada.idNegocio);
    if (bloqueio.bloqueado) {
      console.info(`Upfront rejeitado por estado do negócio | Empresa ${empresaId} | Deal ${entrada.idNegocio} | Estado ${existente?.estado}`);
      return falha(bloqueio.mensagem, bloqueio.statusCode);
    }

    // Cabeçalho. Oportunidade e id_simulador: se nenhum lado trouxe valor, preserva-se o que há.
    const cabecalho = {
      tituloNegocio: entrada.tituloNegocio,
      idComercial: entrada.idComercial,
      tituloFunil: entrada.nomeFunil,
      idFunil: String(entrada.idFunil),
      idTipoReceita,
      contactoServico: entrada.contactoServico,
      operadoraId,
      ...(idSimulador !== null ? { idSimulador } : {}),
      ...(oportunidade !== null ? { oportunidade } : {}),
    };
    let negocioId: string;
    let estado: string;
    if (existente) {
      await tx.update(sysNegocios).set(cabecalho).where(eq(sysNegocios.id, existente.id));
      negocioId = existente.id;
      estado = existente.estado;
    } else {
      const [novo] = await tx
        .insert(sysNegocios)
        .values({ ...cabecalho, idNegocio: entrada.idNegocio, empresaId, estado: EstadosNegocio.Ativo, dataCriacao: new Date() })
        .returning({ id: sysNegocios.id });
      negocioId = novo.id;
      estado = EstadosNegocio.Ativo;
    }

    // As linhas anteriores saem e entram as novas (a data de início por linha preserva-se).
    const antigas = await tx
      .select()
      .from(sysCalculoComissoes)
      .where(eq(sysCalculoComissoes.idSysNegocio, negocioId))
      .orderBy(asc(sysCalculoComissoes.id));
    const gravacao = prepararGravacaoUpfront({
      linhas,
      existentes: antigas.map((a) => ({
        produtoId: a.produtoId,
        numeroAssociado: a.numeroAssociado,
        dataInicioContrato: a.dataInicioContrato === null ? null : dataCivil(a.dataInicioContrato),
        valorUpfrontBruto: dec(a.valorUpfrontBruto),
        valorUpfrontLiquido: dec(a.valorUpfrontLiquido),
        premiosBruto: dec(a.premiosBruto),
        premiosLiquido: dec(a.premiosLiquido),
      })),
      estadoNegocio: estado,
      inicioContratoDoNegocio: entrada.inicioContrato,
      margemUpfrontPct,
      motivoAcerto: opcoes.motivoAcerto ?? null,
    });

    if (antigas.length > 0) await tx.delete(sysCalculoComissoes).where(eq(sysCalculoComissoes.idSysNegocio, negocioId));

    const agora = new Date();
    if (gravacao.linhas.length > 0) {
      await tx.insert(sysCalculoComissoes).values(
        gravacao.linhas.map((l) => ({
          idSysNegocio: negocioId,
          descricaoProduto: l.descricaoProduto,
          produtoId: l.produtoId,
          duracaoContrato: l.duracaoContrato,
          dataInicioContrato: l.dataInicioContrato,
          quantidade: l.quantidade,
          numeroAssociado: l.numeroAssociado,
          pricingPlanId: l.pricingPlanId,
          upfront: l.upfront.toString(),
          oferta: l.oferta,
          valorUnidade: l.valorUnidade.toString(),
          ajusteDuracao: l.ajusteDuracao.toString(),
          margemPercentagem: l.margemPercentagem.toString(),
          valorUpfrontBruto: l.valorUpfrontBruto.toString(),
          valorUpfrontLiquido: l.valorUpfrontLiquido.toString(),
          dataCalculo: agora,
          operadoraId,
          empresaId,
        })),
      );
    }

    if (gravacao.acerto) {
      const a = gravacao.acerto;
      await tx.insert(sysNegocioAcertos).values({
        empresaId,
        idTipoAcerto: a.idTipoAcerto,
        idSysNegocio: negocioId,
        idCalculo: null, // as linhas acabaram de ser recriadas com ids novos
        valorAntesBruto: a.valorAntesBruto.toString(),
        valorAntesLiquido: a.valorAntesLiquido.toString(),
        valorDepoisBruto: a.valorDepoisBruto.toString(),
        valorDepoisLiquido: a.valorDepoisLiquido.toString(),
        deltaBruto: a.deltaBruto.toString(),
        deltaLiquido: a.deltaLiquido.toString(),
        motivo: a.motivo,
        criadoPorUserId: opcoes.userIdAcerto ?? null,
        criadoEm: agora,
      });
      console.info(
        `Acerto de recálculo | Empresa ${empresaId} | Negocio ${negocioId} | Liquido ${a.valorAntesLiquido} -> ${a.valorDepoisLiquido} | ${a.motivo}`,
      );
    }

    await tx.insert(sysLogErros).values({
      empresaId,
      fluxo: FLUXO_LOG,
      mensagemErro: `Upfront calculado com sucesso para negócio ${entrada.idNegocio} - ${entrada.tituloNegocio ?? ""}`.slice(0, 500),
      dataErro: agora,
    });

    console.info(
      `Upfront apurado | Empresa ${empresaId} | Negocio ${entrada.idNegocio} | ${gravacao.linhas.length}/${produtos.length} linhas com cálculo`,
    );
    return { ok: true, ignorado: false, linhasCriadas: gravacao.linhas.length, linhasSemCalculo };
  });
}

function descreverAviso(a: AvisoUpfront): string {
  switch (a.tipo) {
    case "sem-observacoes":
      return `produto ${a.produtoId} sem observações da app — linha sem cálculo.`;
    case "produto-nao-encontrado":
      return `produto ${a.produtoId} não encontrado no Pipedrive.`;
    case "classificacao-invalida":
      return `produto ${a.produtoId} sem classificacao_oferta válida (valor bruto: ${a.valor ?? "<null>"}).`;
    case "option-sem-mapeamento":
      return `option ID ${a.optionId} sem mapeamento em org_empresa_oferta_pipedrive.`;
    case "sem-plano-comissional":
      return `sem plano comissional para a oferta ${a.ofertaId} (objetivos_atingidos=0).`;
    case "sem-ajuste-duracao":
      return `sem ajuste de duração para ${a.duracaoMeses} meses (produto ${a.produtoId}) — subscrição sem cálculo.`;
  }
}
