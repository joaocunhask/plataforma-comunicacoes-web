// O apuramento do upfront de ponta a ponta contra um Postgres LOCAL (o do ETL/dev), com o
// Pipedrive simulado. Tudo corre numa transação que no fim se desfaz: a BD fica como estava.
// Sem DATABASE_URL local no .env.local, o teste é saltado.
import { config } from "dotenv";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

config({ path: ".env.local", quiet: true });
const url = process.env.DATABASE_URL;
const local = !!url && ["localhost", "127.0.0.1"].includes(new URL(url).hostname);

class Desfazer extends Error {}

describe.skipIf(!local)("apurarUpfront com a BD", () => {
  it("cria o negócio e as linhas, regista o acerto, preserva datas e respeita o estado", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { apurarUpfront } = await import("@/lib/apuramento/upfront");
    const { NumeroJson } = await import("@/lib/pipedrive/json-exato");
    const { NetDecimal } = await import("@/lib/calculo");

    const OBS = (subs: object[]) => `⚠ Gerado pela app Preencher Produtos — não remover.\n${JSON.stringify({ subscricoes: subs })}`;
    const pipedrive = {
      obterProdutosDoNegocio: async () => [
        {
          id: 1,
          produtoId: 501,
          nome: "Red Pro",
          precoUnitario: NetDecimal.de("49.90"),
          quantidade: 2,
          observacoes: OBS([
            { numero: "911111111", duracao_meses: 30 },
            { numero: "922222222", duracao_meses: 24 },
          ]),
        },
        { id: 2, produtoId: 502, nome: "Sem obs", precoUnitario: NetDecimal.de("10"), quantidade: 1, observacoes: null },
      ],
      obterProduto: async (id: number) => ({ id, nome: "Red Pro", campos: { cls: new NumeroJson("55"), ppid: " PP123 " } }),
      obterNegocio: async (id: number) => ({ id, nome: null, campos: { op: "OP-1", owner_id: { id: 777 } } }),
    };

    await db
      .transaction(async (tx) => {
        // ── Configuração mínima de uma empresa de teste ───────────────────────
        let [vodafone] = await tx.select().from(s.refOperadoras).where(eq(s.refOperadoras.nome, "Vodafone"));
        if (!vodafone) [vodafone] = await tx.insert(s.refOperadoras).values({ nome: "Vodafone" }).returning();
        const [tr] = await tx.insert(s.refTipoReceitas).values({ tipoReceita: "TESTE_TR" }).returning();
        const [oferta] = await tx.insert(s.refOfertas).values({ nome: "TESTE_OFERTA", operadoraId: vodafone.id }).returning();
        const [empresa] = await tx.insert(s.orgEmpresas).values({ nome: "[TESTE] webhook", pipedriveApiToken: "tok-teste-webhook" }).returning();
        const userId = crypto.randomUUID();
        await tx.insert(s.aspNetUsers).values({ id: userId, email: `${userId}@exemplo.test`, emailConfirmed: true });
        await tx.insert(s.orgMembros).values({ aspnetUserId: userId, empresaId: empresa.id, idCrm: "777" });
        await tx.insert(s.refObjetivos).values({ empresaId: empresa.id, operadoraId: vodafone.id, idFunilPipedrive: 9001, idTipoReceita: tr.id });
        await tx.insert(s.orgEmpresaPipedriveFieldMap).values([
          { empresaId: empresa.id, chaveLogica: "classificacao_oferta", pipedriveFieldKey: "cls" },
          { empresaId: empresa.id, chaveLogica: "pricing_plan_id", pipedriveFieldKey: "ppid" },
          { empresaId: empresa.id, chaveLogica: "oportunidade", pipedriveFieldKey: "op" },
        ]);
        await tx.insert(s.orgEmpresaOfertaPipedrive).values({ empresaId: empresa.id, ofertaId: oferta.id, pipedriveOptionId: 55 });
        await tx
          .insert(s.refPlanoComissionalVodafone)
          .values({ empresaId: empresa.id, tipoReceita: tr.id, oferta: oferta.id, objetivosAtingidos: 0, upfront: "0.5000" });
        await tx.insert(s.refAjusteComissaoVodafone).values([
          { empresaId: empresa.id, duracaoMin: 1, duracaoMax: 24, ajuste: "1.0000" },
          { empresaId: empresa.id, duracaoMin: 25, duracaoMax: 36, ajuste: "1.2000" },
        ]);
        await tx
          .insert(s.cfgMargens)
          .values({ empresaId: empresa.id, aspnetUserId: userId, operadoraId: vodafone.id, tipo: "upfront", margemPercentagem: "80.00" });

        const entrada = {
          idFunil: 9001,
          nomeFunil: "Nova RLMC",
          idNegocio: 424242,
          tituloNegocio: "Cliente Teste",
          idComercial: 777,
          contactoServico: null,
          inicioContrato: "2026-07-31" as never,
          idSimulador: "SIM-1",
          oportunidade: null,
        };
        const opcoes = { db: tx, pipedrive, motivoAcerto: "teste" };

        // ── 1.ª vez: cria tudo ─────────────────────────────────────────────────
        expect(await apurarUpfront(entrada, empresa.id, opcoes)).toEqual({ ok: true, ignorado: false, linhasCriadas: 2, linhasSemCalculo: 1 });

        const [negocio] = await tx.select().from(s.sysNegocios).where(eq(s.sysNegocios.empresaId, empresa.id));
        expect(negocio).toMatchObject({ idNegocio: 424242, estado: "ATIVO", idFunil: "9001", idTipoReceita: tr.id, oportunidade: "OP-1", idSimulador: "SIM-1" });

        const linhas = async () =>
          (await tx.select().from(s.sysCalculoComissoes).where(eq(s.sysCalculoComissoes.idSysNegocio, negocio.id))).sort((a, b) =>
            (a.numeroAssociado ?? "").localeCompare(b.numeroAssociado ?? ""),
          );
        // 49.90 × 1.2 × 0.5 = 29.94 (líquido 20% → 5.99); 49.90 × 1.0 × 0.5 = 24.95 (→ 4.99)
        expect((await linhas()).map((l) => [l.numeroAssociado, l.duracaoContrato, l.valorUpfrontBruto, l.valorUpfrontLiquido, l.dataInicioContrato, l.pricingPlanId, l.margemPercentagem])).toEqual([
          ["911111111", 30, "29.94", "5.99", "2026-07-31", "PP123", "80.00"],
          ["922222222", 24, "24.95", "4.99", "2026-07-31", "PP123", "80.00"],
        ]);

        const acertos = () => tx.select().from(s.sysNegocioAcertos).where(eq(s.sysNegocioAcertos.idSysNegocio, negocio.id));
        expect((await acertos()).map((a) => [a.valorAntesBruto, a.valorDepoisBruto, a.valorDepoisLiquido, a.deltaBruto, a.motivo])).toEqual([
          ["0.00", "54.89", "10.98", "0.00", "teste"],
        ]);

        // ── 2.ª vez, igual: linhas recriadas, data editada preservada, sem acerto novo ──
        await tx
          .update(s.sysCalculoComissoes)
          .set({ dataInicioContrato: "2026-09-01" })
          .where(and(eq(s.sysCalculoComissoes.idSysNegocio, negocio.id), eq(s.sysCalculoComissoes.numeroAssociado, "911111111")));
        await apurarUpfront({ ...entrada, idSimulador: null }, empresa.id, opcoes);
        expect((await linhas()).map((l) => l.dataInicioContrato)).toEqual(["2026-09-01", "2026-07-31"]);
        expect(await acertos()).toHaveLength(1);
        const [depois] = await tx.select().from(s.sysNegocios).where(eq(s.sysNegocios.id, negocio.id));
        expect(depois.idSimulador).toBe("SIM-1"); // sem valor novo, preserva-se

        // ── Funil não configurado: ignorado ───────────────────────────────────
        expect(await apurarUpfront({ ...entrada, idFunil: 1 }, empresa.id, opcoes)).toMatchObject({ ok: true, ignorado: true });

        // ── Comercial desconhecido: falha ─────────────────────────────────────
        expect(await apurarUpfront({ ...entrada, idComercial: 1 }, empresa.id, opcoes)).toMatchObject({ ok: false, statusCode: 500 });

        // ── Anulado: 409, nada muda ───────────────────────────────────────────
        await tx.update(s.sysNegocios).set({ estado: "ANULADO" }).where(eq(s.sysNegocios.id, negocio.id));
        expect(await apurarUpfront(entrada, empresa.id, opcoes)).toMatchObject({ ok: false, statusCode: 409 });

        throw new Desfazer();
      })
      .catch((e) => {
        if (!(e instanceof Desfazer)) throw e;
      });
  });
});
