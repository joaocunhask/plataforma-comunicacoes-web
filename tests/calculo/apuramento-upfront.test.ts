// Cenários de tests/.../Vodafone/UpfrontWebhookEndpointTests.cs, sem a BD nem o Pipedrive.
import { describe, expect, it } from "vitest";
import {
  type ConfigUpfront,
  calcularLinhasUpfront,
  chaveLinha,
  type DetalhesProduto,
  type LinhaUpfrontExistente,
  lerCampoDoNegocio,
  prepararGravacaoUpfront,
  type ProdutoDoNegocio,
  produtosQuePrecisamDeDetalhes,
  TiposAcerto,
  verificarEstadoParaReprocessar,
} from "@/lib/calculo";
import { d, data, expectValor } from "./ajuda";

const AVISO = "⚠ Gerado pela app Preencher Produtos — não remover.\n";
const PPID = "PPID-10285";

const observacoes = (subscricoes: object[]) => AVISO + JSON.stringify({ subscricoes });

/** Produto 10285 com uma subscrição de 24 meses por número (como FakeClientComProduto10285). */
function produto10285(numeros: string[] = ["911111111"], alteracoes: Partial<ProdutoDoNegocio> = {}): ProdutoDoNegocio {
  return {
    produtoId: 10285,
    nome: "PACK",
    precoUnitario: d(100),
    observacoes: observacoes(numeros.map((numero) => ({ numero, duracao_meses: 24 }))),
    ...alteracoes,
  };
}

const detalhes10285: DetalhesProduto = { classificacaoOferta: "118", pricingPlanId: PPID };

/** O contexto de SeedApuramentoContextAsync: GOLD (option 118) → upfront 6.0; 24-29m → 1.0. */
const config = (margem: string | null = "50"): ConfigUpfront => ({
  ofertaPorOption: new Map([[118, 1]]),
  planoPorOferta: new Map([[1, d("6.0")]]),
  ajustesDuracao: [{ duracaoMin: 24, duracaoMax: 29, ajuste: d("1.0") }],
  margemUpfrontPct: margem === null ? null : d(margem),
});

function apurar(produtos: ProdutoDoNegocio[], cfg = config(), detalhes = new Map([[10285, detalhes10285]])) {
  return calcularLinhasUpfront(produtos, detalhes, cfg);
}

function gravar(
  produtos: ProdutoDoNegocio[],
  opcoes: { estado?: string; existentes?: LinhaUpfrontExistente[]; margem?: string | null; motivo?: string | null } = {},
) {
  const margem = opcoes.margem === undefined ? "50" : opcoes.margem;
  const { linhas } = apurar(produtos, config(margem));
  return prepararGravacaoUpfront({
    linhas,
    existentes: opcoes.existentes ?? [],
    estadoNegocio: opcoes.estado ?? "ATIVO",
    inicioContratoDoNegocio: data("2026-07-01"),
    margemUpfrontPct: margem === null ? null : d(margem),
    motivoAcerto: opcoes.motivo ?? null,
  });
}

describe("apuramento de upfront — cenários do webhook", () => {
  it("happy path: uma linha por subscrição com o upfront calculado (100 × 1.0 × 6.0 = 600; margem 50 → 300)", () => {
    const { linhas, acerto } = gravar([produto10285()]);
    expect(acerto).toBeNull();
    expect(linhas).toHaveLength(1);
    const l = linhas[0];
    expectValor(l.valorUpfrontBruto, "600.00");
    expectValor(l.valorUpfrontLiquido, "300.00");
    expectValor(l.upfront, "6.0");
    expectValor(l.ajusteDuracao, "1.0");
    expectValor(l.margemPercentagem, 50);
    expect(l.oferta).toBe("1"); // convenção herdada: o int guardado como texto
    expectValor(l.valorUnidade, 100);
    expect(l.quantidade).toBe(1);
    expect(l.duracaoContrato).toBe(24);
    expect(l.numeroAssociado).toBe("911111111");
    expect(l.pricingPlanId).toBe(PPID);
    expect(l.dataInicioContrato).toBe("2026-07-01");
  });

  it("margem null: parceiro salvaguardado, líquido 0, e grava a margem aplicada (100) para auditoria", () => {
    const { linhas } = gravar([produto10285()], { margem: null });
    expectValor(linhas[0].valorUpfrontBruto, "600.00");
    expectValor(linhas[0].valorUpfrontLiquido, "0.00");
    expectValor(linhas[0].margemPercentagem, 100);
  });

  it("várias subscrições geram uma linha por número", () => {
    const { linhas } = gravar([produto10285(["911111111", "922222222", "933333333"])]);
    expect(linhas.map((l) => l.numeroAssociado)).toEqual(["911111111", "922222222", "933333333"]);
    for (const l of linhas) {
      expect(l.quantidade).toBe(1);
      expectValor(l.valorUpfrontBruto, "600.00");
      expectValor(l.valorUpfrontLiquido, "300.00");
    }
  });

  it("reprocesso preserva a data de início de cada linha (editável no painel)", () => {
    const existente = (numero: string, dataInicio: string): LinhaUpfrontExistente => ({
      produtoId: 10285,
      numeroAssociado: numero,
      dataInicioContrato: data(dataInicio),
      valorUpfrontBruto: null,
      valorUpfrontLiquido: null,
      premiosBruto: null,
      premiosLiquido: null,
    });
    const { linhas } = gravar([produto10285(["911111111", "922222222"])], {
      existentes: [existente("911111111", "2026-03-01"), existente("922222222", "2026-05-15")],
    });
    expect(linhas.map((l) => l.dataInicioContrato)).toEqual(["2026-03-01", "2026-05-15"]);
  });

  it("subscrição sem número gera linha com número null (o cálculo não depende do número)", () => {
    const { linhas } = gravar([produto10285([], { observacoes: observacoes([{ duracao_meses: 24 }]) })]);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].numeroAssociado).toBeNull();
    expect(linhas[0].duracaoContrato).toBe(24);
    expectValor(linhas[0].valorUpfrontBruto, "600.00");
  });

  it("produto sem número com quantidade 20 calcula sobre o total, numa só linha", () => {
    const { linhas } = gravar([produto10285([], { observacoes: observacoes([{ duracao_meses: 24, quantidade: 20 }]) })]);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].quantidade).toBe(20);
    expectValor(linhas[0].valorUpfrontBruto, "12000.00");
    expectValor(linhas[0].valorUpfrontLiquido, "6000.00");
  });

  it("produto sem observações da app não gera cálculo (nem precisa de detalhes)", () => {
    const produto = produto10285([], { observacoes: null });
    expect(produtosQuePrecisamDeDetalhes([produto])).toEqual([]);
    const r = apurar([produto], config(), new Map());
    expect(r.linhas).toEqual([]);
    expect(r.linhasSemCalculo).toBe(1);
    expect(r.avisos).toEqual([{ tipo: "sem-observacoes", produtoId: 10285 }]);
  });

  it.each(["ANULADO", "PROCESSADO"])("negócio %s não se reprocessa (409)", (estado) => {
    expect(verificarEstadoParaReprocessar(estado, 6)).toEqual({
      bloqueado: true,
      statusCode: 409,
      mensagem: `Negócio 6 está em estado ${estado}; re-active-o no painel Admin para permitir reprocessamento.`,
    });
    expect(verificarEstadoParaReprocessar("ATIVO", 6)).toEqual({ bloqueado: false });
    expect(verificarEstadoParaReprocessar(null, 6)).toEqual({ bloqueado: false });
  });

  it("EM_VALIDACAO reprocessa, mas não repõe a data deal-level (a linha fica sem data)", () => {
    expect(verificarEstadoParaReprocessar("EM_VALIDACAO", 6)).toEqual({ bloqueado: false });
    const { linhas } = gravar([produto10285()], { estado: "EM_VALIDACAO" });
    expectValor(linhas[0].valorUpfrontBruto, "600.00");
    expect(linhas[0].dataInicioContrato).toBeNull();
  });
});

describe("apuramento de upfront — produtos e subscrições sem cálculo", () => {
  it("conta as subscrições perdidas em cada motivo, pela ordem dos produtos", () => {
    const dois = observacoes([
      { numero: "1", duracao_meses: 24 },
      { numero: "2", duracao_meses: 24 },
    ]);
    const produtos: ProdutoDoNegocio[] = [
      { produtoId: 1, nome: "não existe", precoUnitario: d(10), observacoes: dois },
      { produtoId: 2, nome: "classificação", precoUnitario: d(10), observacoes: dois },
      { produtoId: 3, nome: "option", precoUnitario: d(10), observacoes: dois },
      { produtoId: 4, nome: "plano", precoUnitario: d(10), observacoes: dois },
      { produtoId: 5, nome: "duração", precoUnitario: d(10), observacoes: observacoes([{ duracao_meses: 60 }, { duracao_meses: 24 }]) },
    ];
    const cfg = { ...config(), ofertaPorOption: new Map([[118, 1], [119, 2]]) };
    const detalhes = new Map<number, DetalhesProduto | null>([
      [1, null],
      [2, { classificacaoOferta: "abc", pricingPlanId: null }],
      [3, { classificacaoOferta: "999", pricingPlanId: null }],
      [4, { classificacaoOferta: "119", pricingPlanId: null }],
      [5, { classificacaoOferta: " 118 ", pricingPlanId: "  P5  " }],
    ]);
    const r = calcularLinhasUpfront(produtos, detalhes, cfg);
    expect(r.linhasSemCalculo).toBe(9);
    expect(r.avisos.map((a) => a.tipo)).toEqual([
      "produto-nao-encontrado",
      "classificacao-invalida",
      "option-sem-mapeamento",
      "sem-plano-comissional",
      "sem-ajuste-duracao",
    ]);
    expect(r.linhas).toHaveLength(1); // a subscrição de 24m do produto 5
    expect(r.linhas[0].pricingPlanId).toBe("P5"); // aparado, como o Trim() do C#
  });

  it("detalhes em falta no mapa é um erro de quem chama", () => {
    expect(() => apurar([produto10285()], config(), new Map())).toThrow(/faltam os detalhes/);
  });

  it("com faixas de duração sobrepostas ganha a primeira (o FirstOrDefault do C#)", () => {
    const cfg = {
      ...config(),
      ajustesDuracao: [
        { duracaoMin: 24, duracaoMax: 29, ajuste: d("1.0") },
        { duracaoMin: 20, duracaoMax: 30, ajuste: d("2.0") },
      ],
    };
    expectValor(apurar([produto10285()], cfg).linhas[0].ajusteDuracao, "1.0");
  });
});

describe("apuramento de upfront — acerto RECALCULO", () => {
  const existente = (bruto: string, liquido: string, premio: string | null = null): LinhaUpfrontExistente => ({
    produtoId: 10285,
    numeroAssociado: "911111111",
    dataInicioContrato: data("2026-07-01"),
    valorUpfrontBruto: d(bruto),
    valorUpfrontLiquido: d(liquido),
    premiosBruto: premio === null ? null : d(premio),
    premiosLiquido: premio === null ? null : d(premio),
  });

  it("só se grava se o dinheiro mudou; os valores antes incluem os prémios; o delta é zero", () => {
    expect(gravar([produto10285()], { existentes: [existente("600.00", "300.00")], motivo: "webhook" }).acerto).toBeNull();

    const { acerto } = gravar([produto10285()], { existentes: [existente("600.00", "300.00", "15.00")], motivo: "webhook" });
    expect(acerto?.idTipoAcerto).toBe(TiposAcerto.Recalculo);
    expectValor(acerto?.valorAntesBruto, "615.00");
    expectValor(acerto?.valorAntesLiquido, "315.00");
    expectValor(acerto?.valorDepoisBruto, "600.00");
    expectValor(acerto?.valorDepoisLiquido, "300.00");
    expectValor(acerto?.deltaBruto, 0);
    expectValor(acerto?.deltaLiquido, 0);
    expect(acerto?.motivo).toBe("webhook");
  });

  it("sem motivo (quem chama grava o seu próprio acerto) não se grava nada", () => {
    expect(gravar([produto10285()], { existentes: [existente("1.00", "1.00")] }).acerto).toBeNull();
  });
});

describe("utilitários do apuramento de upfront", () => {
  it("chaveLinha: pelo número (aparado) quando existe, senão pelo produto", () => {
    expect(chaveLinha(10285, " 911 ")).toBe("n:911");
    expect(chaveLinha(10285, "   ")).toBe("p:10285");
    expect(chaveLinha(null, null)).toBe("p:");
  });

  it("lerCampoDoNegocio: vazio vira null para se usar o payload", () => {
    expect(lerCampoDoNegocio("  OPP-1 ")).toBe("OPP-1");
    expect(lerCampoDoNegocio("   ")).toBeNull();
    expect(lerCampoDoNegocio(null)).toBeNull();
  });
});
