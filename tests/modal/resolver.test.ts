// Port de tests/.../Pipedrive/ContractLineResolverTests.cs.
//
// Os dois primeiros testes replicam simulações reais da Vodafone (RUN6). São o oráculo desta
// funcionalidade: em ambas, a linha que carrega o dinheiro é um produto agregador (bundle) que o
// simulador imprime SEM pricing_plan_id. Antes, o extractor era obrigado pelo schema a devolver
// um PPID de 9 dígitos, e acabava por copiar o da linha vizinha — a comissão saía calculada sobre
// a classificação de oferta do produto errado.
import { describe, expect, it } from "vitest";
import { NetDecimal } from "@/lib/calculo";
import { motivoNaoComissionavel, resolverLinhas, type LinhaContrato, type ProdutoCatalogo } from "@/lib/modal/resolver";

// Catálogo com os produtos reais envolvidos (PPID e nome conforme RUN6).
const CATALOGO: ProdutoCatalogo[] = [
  { id: 9001, nome: "4P Biz Start 2026", pricingPlanId: "100301320" },
  { id: 9002, nome: "3P Biz Start 2026", pricingPlanId: "100301319" },
  { id: 9003, nome: "Cartão Móvel Biz Infinity Start", pricingPlanId: "100102711" },
  { id: 9004, nome: "2P PRO + Minf 2025", pricingPlanId: "100301271" },
  // Mesmo nome, ofertas diferentes (GOLD / BRONZE) — o caso ambíguo real.
  { id: 9005, nome: "2P PRO + MInf", pricingPlanId: "100301211" },
  { id: 9006, nome: "2P PRO + MInf", pricingPlanId: "100301243" },
];

/** Uma linha tal como o extractor a transcreve: por omissão, sem permanência e sem valor
 * (o caso dos descontos, OTTs e serviços de apoio). */
function linha(nome: string, o: { ppid?: string | null; duracao?: number; rlmc?: string } = {}): LinhaContrato {
  return {
    nomeProduto: nome,
    quantidade: 1,
    duracaoContratoMeses: o.duracao ?? 0,
    multaMensal: NetDecimal.de(o.rlmc ?? "0"),
    pricingPlanId: o.ppid ?? null,
  };
}

describe("resolverLinhas", () => {
  it("simulação real com bundle 4P admite só as duas linhas com contrato e RLMC", () => {
    // Conta 309577708: 13 linhas no simulador, das quais só duas têm
    // permanência — o bundle (sem PPID no texto) e um cartão móvel (com PPID).
    const linhas = [
      linha("Desc Bundle Fixo Emp 25% Edit"),
      linha("Desc 5Eur Fixo 2026"),
      linha("4P Biz Start 2026", { duracao: 24, rlmc: "54.00" }), // bundle, sem PPID
      linha("AmazonPrime_oferta_24m_por_ativar"),
      linha("Desc 15Eur_OTTs Bundle 2026"),
      linha("HBOMax_oferta_comAds_3m_por_ativar"),
      linha("Net 1Gbps/1Gbps_VBU 2026", { ppid: "100093209" }), // tem PPID mas não comissiona
      linha("Suporte Especializado Fixo"),
      linha("Suporte Especializado Móvel"),
      linha("Suporte Especializado Móvel"),
      linha("Cartão Móvel Biz Infinity Start", { ppid: "100102711" }), // mesma ref, sem permanência
      linha("Cartão Móvel Biz Infinity Start", { ppid: "100102711", duracao: 24, rlmc: "7.00" }),
      linha("Desc Fidelização VM_inBundle 25%"),
    ];

    const r = resolverLinhas(linhas, CATALOGO);

    expect(r.linhas).toHaveLength(2);
    expect(r.ignoradas).toHaveLength(11);

    // O bundle resolve para o SEU produto, pelo nome.
    const bundle = r.linhas[0];
    expect(bundle.linha.nomeProduto).toBe("4P Biz Start 2026");
    expect(bundle.status).toBe("ok");
    expect(bundle.origem).toBe("nome");
    expect(bundle.pricingPlanId).toBe("100301320");

    // E, sobretudo, NÃO ficou com o PPID da linha do Net — o bug original.
    expect(bundle.pricingPlanId).not.toBe("100093209");

    // O cartão móvel resolve pelo PPID que o texto trazia.
    const cartao = r.linhas[1];
    expect(cartao.status).toBe("ok");
    expect(cartao.origem).toBe("ppid");
    expect(cartao.pricingPlanId).toBe("100102711");
  });

  it("simulação real com bundle 2P admite só o bundle", () => {
    // Conta 311211299: 8 linhas, uma só com permanência.
    const linhas = [
      linha("Desc Bundle Fixo Emp 25% Edit"),
      linha("2P PRO + Minf 2025", { duracao: 30, rlmc: "73.65" }),
      linha("Adit Roaming 100min iMax", { ppid: "100092623" }),
      linha("Suporte Especializado Móvel"),
      linha("VM_inBundle_InfMax_jun25", { ppid: "100102630" }),
      linha("Net 1Gbps/1Gbps_mar26", { ppid: "100092939" }),
      linha("One Net Dect IP Incl", { ppid: "100091047" }),
      linha("Suporte Especializado Fixo"),
    ];

    const r = resolverLinhas(linhas, CATALOGO);

    expect(r.linhas).toHaveLength(1);
    const l = r.linhas[0];
    expect(r.ignoradas).toHaveLength(7);
    expect(l.status).toBe("ok");
    expect(l.origem).toBe("nome");
    // O sufixo "2025" no nome é o que o distingue do par ambíguo GOLD/BRONZE.
    expect(l.pricingPlanId).toBe("100301271");
  });

  it("nome com vários produtos fica ambíguo em vez de escolher", () => {
    // "2P PRO + MInf" existe em GOLD e BRONZE. A diferença é o multiplicador
    // do upfront, portanto adivinhar seria arbitrar dinheiro.
    const r = resolverLinhas([linha("2P PRO + MInf", { duracao: 24, rlmc: "50" })], CATALOGO);

    expect(r.linhas).toHaveLength(1);
    const l = r.linhas[0];
    expect(l.status).toBe("ambiguo");
    expect(l.pipedriveProductId).toBeNull();
    expect(l.origem).toBeNull();
    expect(l.candidatos).toHaveLength(2);
    expect(l.candidatos.some((c) => c.pricingPlanId === "100301211")).toBe(true);
    expect(l.candidatos.some((c) => c.pricingPlanId === "100301243")).toBe(true);
  });

  it.each([
    ["2p pro + minf 2025"], // caixa diferente
    ["2P PRO + MINF 2025"],
    ["  2P PRO + Minf   2025 "], // espaços a mais
    ["2P PRO + Mínf 2025"], // acento
  ])("match por nome ignora caixa, acentos e espaços: %j", (nomeNoSimulador) => {
    const r = resolverLinhas([linha(nomeNoSimulador, { duracao: 30, rlmc: "73.65" })], CATALOGO);

    expect(r.linhas).toHaveLength(1);
    expect(r.linhas[0].status).toBe("ok");
    expect(r.linhas[0].pricingPlanId).toBe("100301271");
  });

  it("nome sem correspondência fica não encontrado", () => {
    const r = resolverLinhas([linha("Produto Que Não Existe", { duracao: 24, rlmc: "30" })], CATALOGO);

    expect(r.linhas).toHaveLength(1);
    expect(r.linhas[0].status).toBe("nao_encontrado");
    expect(r.linhas[0].pipedriveProductId).toBeNull();
  });

  it("PPID que não existe no catálogo fica ppid_desconhecido", () => {
    const r = resolverLinhas([linha("Seja o que for", { ppid: "999999999", duracao: 24, rlmc: "30" })], CATALOGO);

    expect(r.linhas).toHaveLength(1);
    expect(r.linhas[0].status).toBe("ppid_desconhecido");
    expect(r.linhas[0].pipedriveProductId).toBeNull();
  });

  it("produto local do parceiro sem PPID não captura o nome", () => {
    // Órfãos (produtos criados no Pipedrive do parceiro, que a sincronização
    // ignora) não podem apanhar um nome — levariam o cálculo para um produto
    // que a Vodafone não comissiona.
    const catalogo: ProdutoCatalogo[] = [
      { id: 7001, nome: "4P Biz Start 2026", pricingPlanId: "" }, // órfão, sem PPID
    ];
    const r = resolverLinhas([linha("4P Biz Start 2026", { duracao: 24, rlmc: "54" })], catalogo);

    expect(r.linhas).toHaveLength(1);
    expect(r.linhas[0].status).toBe("nao_encontrado");
  });

  it.each([
    [0, "54.00", "Sem duração de contrato."],
    [24, "0.00", "Sem multa mensal (RLMC) — o upfront seria zero."],
    [0, "0.00", "Sem contrato de permanência nem multa mensal — não gera comissão."],
  ])("linha sem duração ou sem RLMC é ignorada com motivo (duração %i, RLMC %s)", (duracao, rlmc, motivoEsperado) => {
    const r = resolverLinhas([linha("4P Biz Start 2026", { duracao, rlmc })], CATALOGO);

    expect(r.linhas).toHaveLength(0);
    expect(r.ignoradas).toHaveLength(1);
    expect(r.ignoradas[0].nomeProduto).toBe("4P Biz Start 2026");
    expect(r.ignoradas[0].motivo).toBe(motivoEsperado);
  });
});

describe("motivoNaoComissionavel", () => {
  it("linha com duração e RLMC é admitida", () => {
    expect(motivoNaoComissionavel(linha("4P Biz Start 2026", { duracao: 24, rlmc: "54" }))).toBeNull();
  });
});
