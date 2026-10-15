// Port de tests/.../Funis/ClassificadorFunilTests.cs e ExcecoesFunilTests.cs.
//
// Fixa a matriz de classificação produto → funil contra os dados REAIS da RUN7 (cross-tab
// "Linha de Produto × Atingimento" do Excel oficial) e os 5 objetivos do plano comissional
// Vodafone.
//
// O que estes testes protegem é dinheiro: um produto no funil errado é comissão calculada sobre
// a oferta errada — o mesmo tipo de falha que os bundles já causaram quando o PPID era inferido
// em vez de lido.
import { describe, expect, it } from "vitest";
import {
  aplicarExcecoes,
  atingimentoDoProduto,
  decompor,
  pertenceAoFunil,
  resolverFunis,
  TiposReceita,
  type ExcecaoFunil,
  type ObjetivoFunil,
  type ProdutoParaExcecao,
} from "@/lib/modal/funis";

const NOVA = TiposReceita.NovaReceita; // 1
const REFID = TiposReceita.Refidelizacao; // 2

const objetivo = (
  objetivoId: number,
  idFunilPipedrive: number,
  nomeFunil: string | null,
  atingimentoLinha: string | null,
  idTipoReceita: number | null,
): ObjetivoFunil => ({ objetivoId, idFunilPipedrive, nomeFunil, atingimentoLinha, idTipoReceita });

/** Os 5 objetivos reais (iguais nas empresas 1 e 5). */
const objetivos = (): ObjetivoFunil[] => [
  objetivo(1, 1, "RLMC1 | VDF", "GSM", NOVA),
  objetivo(2, 2, "RLMC2 | VDF", "GSM", REFID),
  objetivo(3, 3, "RLMC3 | VDF", "Fixo", NOVA),
  objetivo(4, 4, "RLMC4 | VDF", "Fixo", REFID),
  objetivo(5, 5, "RLMC5 | VDF", "Smart Solutions", NOVA),
];

function funilUnico(atingimento: string | null, tipo: number): number | null {
  const r = resolverFunis(atingimento, tipo, objetivos());
  return r.length === 1 ? r[0].idFunilPipedrive : null;
}

describe("ClassificadorFunil", () => {
  // ── A matriz, como a Vodafone a define ──────────────────────────────────

  it.each([
    // Venda nova: VOZ_MOVEL e DADOS_MOVEIS -> GSM; IOT e ICT -> Smart Solutions
    ["GSM", NOVA, 1],
    ["Smart Solutions", NOVA, 5],
    ["Fixo", NOVA, 3],
    // Refidelização: IOT passa a GSM e ICT passa a Fixo (os funis "& IoT"/"& ICT")
    ["GSM", REFID, 2],
    ["Fixo", REFID, 4],
  ])("atingimento %j e tipo de receita %i determinam o funil %i", (atingimento, tipo, funilEsperado) => {
    expect(funilUnico(atingimento, tipo)).toBe(funilEsperado);
  });

  it("Smart Solutions não existe em refidelização", () => {
    // Só há objetivo de Smart Solutions para venda nova. Em refidelização os
    // produtos IoT/ICT trazem já GSM/Fixo na sua própria coluna, por isso
    // este atingimento nunca deve casar com nada.
    expect(resolverFunis("Smart Solutions", REFID, objetivos())).toEqual([]);
  });

  // ── Pacotes Convergentes: um produto, dois funis ─────────────────────────

  it.each([
    [NOVA, 1, 3],
    [REFID, 2, 4],
  ])("convergente pertence aos dois funis do seu tipo (tipo %i → %i e %i)", (tipo, funilMovel, funilFixo) => {
    const r = resolverFunis("GSM e/ou FIXO", tipo, objetivos());

    expect(r).toHaveLength(2);
    expect(r.some((o) => o.idFunilPipedrive === funilMovel)).toBe(true);
    expect(r.some((o) => o.idFunilPipedrive === funilFixo)).toBe(true);
  });

  it("convergente nunca é expulso do negócio onde está", () => {
    // É a razão de ser do tratamento especial: pela linha de produto um
    // Pacote Convergente é FIXO como outro qualquer, e num negócio de Móvel
    // seríamos nós a mandá-lo sair — erradamente.
    const movelNova = objetivos()[0]; // funil 1, GSM, Nova
    const fixoNova = objetivos()[2]; // funil 3, Fixo, Nova

    expect(pertenceAoFunil("GSM e/ou FIXO", "GSM e/ou FIXO", movelNova)).toBe(true);
    expect(pertenceAoFunil("GSM e/ou FIXO", "GSM e/ou FIXO", fixoNova)).toBe(true);
  });

  // ── A pergunta central do modal ─────────────────────────────────────────

  it("pertenceAoFunil lê a coluna do tipo de receita do negócio", () => {
    // Um produto IoT: conta para Smart Solutions em venda nova, mas para GSM
    // em refidelização. O mesmo produto pertence a funis diferentes conforme
    // o negócio onde está.
    const iotNova = "Smart Solutions";
    const iotRefid = "GSM";

    const smartSolutions = objetivos()[4]; // funil 5, Nova
    const movelRefid = objetivos()[1]; // funil 2, Refid
    const movelNova = objetivos()[0]; // funil 1, Nova

    expect(pertenceAoFunil(iotNova, iotRefid, smartSolutions)).toBe(true);
    expect(pertenceAoFunil(iotNova, iotRefid, movelRefid)).toBe(true);
    // Num negócio de Móvel NOVO, o IoT não pertence — vai para Smart Solutions.
    expect(pertenceAoFunil(iotNova, iotRefid, movelNova)).toBe(false);
  });

  it("o tipo de receita separa funis com o mesmo atingimento", () => {
    // GSM existe nos funis 1 e 2; é o tipo de receita que desempata.
    const r = resolverFunis("GSM", NOVA, objetivos());
    expect(r).toHaveLength(1);
    expect(r[0].idFunilPipedrive).toBe(1);
  });

  // ── Nunca adivinha ──────────────────────────────────────────────────────

  it.each([[null], [""], ["   "]])("produto sem atingimento (%j) fica por classificar", (atingimento) => {
    expect(resolverFunis(atingimento, NOVA, objetivos())).toEqual([]);
    expect(pertenceAoFunil(atingimento, atingimento, objetivos()[0])).toBe(false);
  });

  it("objetivo sem mapeamento não participa", () => {
    const porMapear: ObjetivoFunil[] = [objetivo(1, 1, "RLMC1 | VDF", null, NOVA), objetivo(3, 3, "RLMC3 | VDF", "  ", NOVA)];

    expect(resolverFunis("GSM", NOVA, porMapear)).toEqual([]);
  });

  it("tipo de receita desconhecido não classifica", () => {
    // "Novo Negócio" existe no catálogo mas o Excel só traz duas colunas de
    // atingimento. Preferimos não classificar a escolher uma ao calhas.
    expect(atingimentoDoProduto(TiposReceita.NovoNegocio, "GSM", "GSM")).toBeNull();

    const objetivoEstranho = objetivo(9, 9, "RLMC9", "GSM", TiposReceita.NovoNegocio);
    expect(pertenceAoFunil("GSM", "GSM", objetivoEstranho)).toBe(false);
  });

  it("sem tipo de receita não classifica", () => {
    expect(resolverFunis("GSM", null, objetivos())).toEqual([]);
    expect(atingimentoDoProduto(null, "GSM", "GSM")).toBeNull();
  });

  // ── Normalização ────────────────────────────────────────────────────────

  it.each([["GSM"], ["gsm"], ["  GSM  "]])("atingimento %j casa independentemente de caixa e espaços", (escrito) => {
    expect(funilUnico(escrito, NOVA)).toBe(1);
  });

  it.each([["Smart Solutions"], ["SMART SOLUTIONS"], ["smart   solutions"]])("atingimento %j casa com espaços colapsados", (escrito) => {
    expect(funilUnico(escrito, NOVA)).toBe(5);
  });

  it.each([["GSM e/ou FIXO"], ["GSM E/OU FIXO"], ["gsm e/ou fixo"]])("separador do convergente é tolerante: %j", (escrito) => {
    expect(decompor(escrito).size).toBe(2);
  });

  it("decompor devolve vazio e não um elemento em branco", () => {
    // Vazio significa "sem informação", não "não pertence a nada" — a
    // distinção é o que impede um produto sem dados de ser dado como fora.
    expect(decompor(null).size).toBe(0);
    expect(decompor("   ").size).toBe(0);
    expect(decompor("GSM").size).toBe(1);
  });
});

// ── Exceções (ref_funil_excecoes) ────────────────────────────────────────────

describe("ExcecoesFunil", () => {
  const ROUTER: ProdutoParaExcecao = { pricingPlanId: "123456789", linhaProduto: "FIXO", areaProduto: "Internet", subareaProduto: "Router 4G" };

  const excecao = (criterio: string, valor: string, idTipoReceita: number | null, atingimentoLinha: string): ExcecaoFunil => ({
    criterio,
    valor,
    idTipoReceita,
    atingimentoLinha,
  });

  const aplicar = (atingimento: string | null, tipo: number, e: ExcecaoFunil) => aplicarExcecoes(atingimento, tipo, ROUTER, [e]).atingimento;

  it("acrescenta a linha da exceção à que o produto já tem", () => {
    const r = aplicarExcecoes("Fixo", TiposReceita.NovaReceita, ROUTER, [excecao("PPID", "123456789", null, "GSM")]);

    expect(r.porExcecao).toBe(true);
    expect(decompor(r.atingimento)).toEqual(new Set(["FIXO", "GSM"]));
  });

  it.each([
    ["LINHA", "fixo"],
    ["AREA", "INTERNET"],
    ["SUBAREA", "router  4g"],
  ])("critérios de texto comparam sem caixa nem espaços (%s = %j)", (criterio, valor) => {
    const r = aplicar("Fixo", TiposReceita.NovaReceita, excecao(criterio, valor, null, "GSM"));
    expect(decompor(r).has("GSM")).toBe(true);
  });

  it("PPID compara exacto", () => {
    const r = aplicar("Fixo", TiposReceita.NovaReceita, excecao("PPID", "12345678", null, "GSM"));
    expect(r).toBe("Fixo");
  });

  it("exceção de outro tipo de receita não se aplica", () => {
    const e = excecao("PPID", "123456789", TiposReceita.Refidelizacao, "GSM");

    expect(aplicar("Fixo", TiposReceita.NovaReceita, e)).toBe("Fixo");
    expect(decompor(aplicar("Fixo", TiposReceita.Refidelizacao, e)).has("GSM")).toBe(true);
  });

  it("linha que o produto já tem não conta como exceção", () => {
    const r = aplicarExcecoes("GSM e/ou FIXO", TiposReceita.NovaReceita, ROUTER, [excecao("PPID", "123456789", null, "Fixo")]);

    expect(r.porExcecao).toBe(false);
    expect(r.atingimento).toBe("GSM e/ou FIXO");
  });

  it("produto sem atingimento fica como está", () => {
    const r = aplicarExcecoes(null, TiposReceita.NovaReceita, ROUTER, [excecao("PPID", "123456789", null, "GSM")]);

    expect(r.atingimento).toBeNull();
    expect(r.porExcecao).toBe(false);
  });
});
