// Cenários de tests/.../Vodafone/ApuramentoTrimestralEndpointTests.cs (sem a BD) e o replay
// do apuramento real de 2026-Q3 (TrimestralOracleTests.cs).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apurarPremios,
  calcularPremio,
  contarObjetivosAtingidos,
  type LinhaParaApuramento,
  linhasDoTrimestre,
  NetDecimal,
  type ObjetivoTrimestralInput,
  realizadoPorFunil,
  validarTrimestre,
  valorRealizadoDoObjetivo,
} from "@/lib/calculo";
import { d, data, dn, expectValor } from "./ajuda";

// ─── Cenários do endpoint (seed de SeedApuramentoDataAsync) ──────────────────

const USER = "user-admin";

function linhaDoSeed(estado = "ATIVO"): LinhaParaApuramento {
  return {
    id: "linha-1",
    idSysNegocio: "neg-1",
    dataInicioContrato: data("2026-07-01"),
    valorUnidade: d(100),
    quantidade: 1,
    upfront: d("6.0"),
    oferta: "1",
    ajusteDuracao: d("1.0"),
    negocio: { id: "neg-1", estado, idFunil: "1", idTipoReceita: 1, idComercial: 100 },
  };
}

/** Os dois passos do serviço, com as colunas geradas do objetivo como o seed as deixa. */
function apurar(linhas: LinhaParaApuramento[], opcoes: { bloqueado?: boolean; margem?: string | null } = {}) {
  const linhasTrimestre = linhasDoTrimestre(linhas, 2026, 3);
  const realizado = valorRealizadoDoObjetivo(1, realizadoPorFunil(linhasTrimestre));
  const resultado = apurarPremios({
    objetivos: [{ idObjetivo: 10, idFunilPipedrive: 1, posicionamento: d("1.0"), pctAtingimento: d("1.0"), atingido: 1 }],
    linhasTrimestre,
    // patamar 1 (o único objetivo é atingido): ponderador 6.15 − upfront 6.00 = 0.15
    planoComissional: [{ tipoReceita: 1, oferta: 1, objetivosAtingidos: 1, ponderadorPremio: d("6.15") }],
    ajustesPropriaLinha: [{ pctMin: d("1.0"), pctMax: d("9.9999"), ajuste: d("1.0") }],
    ajustesCruzados: [{ nrLinhasAbaixo100: 0, ajuste: d("1.0") }],
    membros: [{ idCrm: "100", aspnetUserId: USER, bloqueado: opcoes.bloqueado ?? false }],
    margensPremio: opcoes.margem === null ? [] : [{ aspnetUserId: USER, margemPercentagem: d(opcoes.margem ?? "0") }],
  });
  return { realizado, resultado };
}

describe("apuramento trimestral — cenários", () => {
  it("calcula o prémio (100 × 0.15 = 15.00) e o realizado do objetivo; o negócio passa a PROCESSADO", () => {
    const { realizado, resultado } = apurar([linhaDoSeed()]);
    expectValor(realizado, 100);
    expect(resultado.objetivosAtingidos).toBe(1);
    expect(resultado.premios).toHaveLength(1);
    expectValor(resultado.premios[0].premiosBruto, "15.00");
    expectValor(resultado.premios[0].premiosLiquido, "15.00");
    expect(resultado.negociosAProcessar).toEqual(["neg-1"]);
  });

  it.each(["ANULADO", "EM_VALIDACAO"])("negócio %s não conta para o atingimento, não recebe prémio e não é processado", (estado) => {
    const { realizado, resultado } = apurar([linhaDoSeed(estado)]);
    expectValor(realizado, 0);
    expect(resultado.premios).toEqual([]);
    expect(resultado.negociosAProcessar).toEqual([]);
  });

  it("reapuramento continua a contar negócios já PROCESSADOS (mas não os volta a processar)", () => {
    const { realizado, resultado } = apurar([linhaDoSeed("PROCESSADO")]);
    expectValor(realizado, 100);
    expectValor(resultado.premios[0].premiosBruto, "15.00");
    expect(resultado.negociosAProcessar).toEqual([]);
  });

  it("comercial bloqueado: o bruto conta, o líquido é 0 (margem não resolve → parceiro retém)", () => {
    const { resultado } = apurar([linhaDoSeed()], { bloqueado: true });
    expectValor(resultado.premios[0].premiosBruto, "15.00");
    expectValor(resultado.premios[0].premiosLiquido, 0);
  });

  it("linha fora do trimestre ou sem data não entra", () => {
    const fora = { ...linhaDoSeed(), id: "fora", dataInicioContrato: data("2026-06-30") };
    const semData = { ...linhaDoSeed(), id: "sem-data", dataInicioContrato: null };
    expect(linhasDoTrimestre([fora, semData, linhaDoSeed()], 2026, 3).map((l) => l.id)).toEqual(["linha-1"]);
  });

  it("linhas que não se conseguem apurar ficam em semPremio com o motivo", () => {
    const base = linhaDoSeed();
    const { resultado } = apurar([
      { ...base, id: "funil", negocio: { ...base.negocio, idFunil: "abc" } },
      { ...base, id: "oferta", oferta: null },
      { ...base, id: "tipo", negocio: { ...base.negocio, idTipoReceita: null } },
      { ...base, id: "sem-plano", oferta: "9" },
    ]);
    expect(resultado.semPremio).toEqual([
      { idCalculo: "funil", erro: "id-funil-invalido" },
      { idCalculo: "oferta", erro: "oferta-invalida" },
      { idCalculo: "tipo", erro: "sem-tipo-receita" },
      { idCalculo: "sem-plano", erro: "ponderador-nao-encontrado" },
    ]);
  });

  it("valida o trimestre", () => {
    expect(validarTrimestre(3)).toBeNull();
    expect(validarTrimestre(5)).toBe("Trimestre inválido (1–4).");
  });
});

// ─── Replay do apuramento real de 2026-Q3 (empresa 1) ────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON */
const snapshot: any = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "apuramento-2026-Q3-empresa1.json"), "utf8"),
  // Os decimais ficam como o texto da fixture ("2.1600"): um float já os teria estragado.
  (_chave, valor, contexto?: { source?: string }) =>
    typeof valor === "number" && contexto?.source?.includes(".") ? contexto.source : valor,
);

describe("apuramento trimestral — replay de 2026-Q3 (bate ao cêntimo com o que foi gravado)", () => {
  it("as 5 linhas apuradas dão os mesmos premios_bruto/liquido", () => {
    const objetivos: ObjetivoTrimestralInput[] = snapshot.sys_objetivos_trimestrais.map((o: any) => ({
      idObjetivo: o.id_objetivo,
      idFunilPipedrive: snapshot.ref_objetivos.find((r: any) => r.id === o.id_objetivo).id_funil_pipedrive,
      posicionamento: d(String(o.posicionamento)),
      pctAtingimento: d(String(o.pct_atingimento)),
      atingido: o.atingido === 1,
    }));

    const patamar = contarObjetivosAtingidos(objetivos);
    expect(patamar).toBe(5);

    const linhasAbaixo = objetivos.filter((o) => o.posicionamento.lt(NetDecimal.UM)).length;
    const cruzado = snapshot.ref_ajuste_cruzado.find((a: any) => a.nr_linhas_abaixo_100 === linhasAbaixo);
    const ajusteCruzado = cruzado ? d(String(cruzado.ajuste)) : NetDecimal.UM;
    expectValor(ajusteCruzado, "1.0000");

    const ctx = {
      objetivos,
      planoDoPatamar: snapshot.ref_plano_comissional
        .filter((p: any) => p.objetivos_atingidos === patamar)
        .map((p: any) => ({ tipoReceita: p.tipo_receita, oferta: p.oferta, ponderadorPremio: d(String(p.upfront)) })),
      ajustesPropriaLinha: snapshot.ref_ajuste_propria_linha.map((a: any) => ({
        pctMin: d(String(a.pct_min)),
        pctMax: d(String(a.pct_max)),
        ajuste: d(String(a.ajuste)),
      })),
      ajusteCruzado,
    };

    // Comercial → margem de prémio ativa (id_comercial → id_crm → aspnet_user_id → cfg_margens).
    const margemDoComercial = (idComercial: number): NetDecimal | null => {
      const membro = snapshot.org_membros.find((m: any) => m.id_crm === String(idComercial));
      const margem = membro
        ? snapshot.cfg_margens.find((c: any) => c.aspnet_user_id === membro.aspnet_user_id && c.tipo === "premio" && c.ativo)
        : undefined;
      return margem ? d(String(margem.margem_percentagem)) : null;
    };

    let comOraculo = 0;
    for (const linha of snapshot.sys_calculo_comissoes) {
      const negocio = snapshot.sys_negocios.find((n: any) => n.id.toLowerCase() === linha.id_sys_negocio.toLowerCase());
      // Replay do n8n: o fluxo original tratava margem null como 0 (o motor atual usa 100).
      const margem = (negocio.id_comercial === null ? null : margemDoComercial(negocio.id_comercial)) ?? NetDecimal.ZERO;
      const r = calcularPremio(
        {
          idCalculoComissoes: linha.id,
          idSysNegocio: linha.id_sys_negocio,
          idFunilPipedrive: Number(negocio.id_funil),
          idTipoReceita: negocio.id_tipo_receita,
          oferta: Number(linha.oferta),
          valorUnidade: d(String(linha.valor_unidade)),
          quantidade: linha.quantidade,
          upfrontLinha: d(String(linha.upfront)),
          ajusteDuracao: dn(linha.ajuste_duracao === null ? null : String(linha.ajuste_duracao)),
          margemPremioPct: margem,
        },
        ctx,
      );
      expect(r.erro).toBeNull();
      if (linha.premios_bruto === null) continue; // entrou depois do apuramento: calcula, não há valor a comparar
      comOraculo++;
      expectValor(r.premioBruto, String(linha.premios_bruto));
      expectValor(r.premioLiquido, String(linha.premios_liquido));
    }
    expect(comOraculo).toBe(5);
  });
});
