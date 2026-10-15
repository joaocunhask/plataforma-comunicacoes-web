// As rotas do modal de ponta a ponta contra o Postgres LOCAL, com o Pipedrive e o Claude
// simulados. Cria uma empresa de teste e apaga no fim tudo o que criou.
// Sem DATABASE_URL local no .env.local, o teste é saltado.
import { config } from "dotenv";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

config({ path: ".env.local", quiet: true });
process.env.PIPEDRIVE_CLIENT_ID = "cliente-teste";
process.env.PIPEDRIVE_CLIENT_SECRET = "segredo-de-teste-com-pelo-menos-32-bytes!!";
process.env.PIPEDRIVE_CALLBACK_URL = "https://app.exemplo.test/oauth/pipedrive/callback";
process.env.PIPEDRIVE_TOKENS_KEY = Buffer.alloc(32, 7).toString("base64");

const url = process.env.DATABASE_URL;
const local = !!url && ["localhost", "127.0.0.1"].includes(new URL(url).hostname);

// O Claude simulado: devolve as linhas que o teste quiser.
const linhasDoClaude = vi.hoisted(() => ({ atual: [] as unknown[] }));
vi.mock("@/lib/modal/extrator", async (original) => ({
  ...(await original<typeof import("@/lib/modal/extrator")>()),
  extrairLinhas: async () => linhasDoClaude.atual,
}));

const COMPANY = 777_000_111;
const PD_USER = 4242;
const FUNIL_MOVEL = 9101;
const FUNIL_FIXO = 9102;
const DEAL = 5001;

describe.skipIf(!local)("rotas do modal com a BD", () => {
  let dbm: typeof import("@/db");
  let s: typeof import("@/db/schema");
  let d: typeof import("drizzle-orm");
  let rotas: typeof import("@/lib/modal/rotas");
  let NetDecimal: typeof import("@/lib/calculo").NetDecimal;
  let empresaId = 0;
  let ofertaId = 0;
  const pedidos: { metodo: string; caminho: string; corpo: string | null }[] = [];
  let pesquisa: unknown[] = [];

  const jwt = () =>
    new SignJWT({ user_id: PD_USER, company_id: COMPANY })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(process.env.PIPEDRIVE_CLIENT_SECRET));
  const pedido = async (caminho: string, corpo?: unknown) =>
    new Request(`https://app.exemplo.test${caminho}`, {
      method: corpo === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${await jwt()}`, "Content-Type": "application/json" },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });

  beforeAll(async () => {
    dbm = await import("@/db");
    s = await import("@/db/schema");
    d = await import("drizzle-orm");
    rotas = await import("@/lib/modal/rotas");
    NetDecimal = (await import("@/lib/calculo")).NetDecimal;
    const { cifrar } = await import("@/lib/pipedrive/oauth");
    const db = dbm.db;

    const [vodafone] = await db.select().from(s.refOperadoras).where(d.eq(s.refOperadoras.nome, "Vodafone"));
    const [oferta] = await db.insert(s.refOfertas).values({ nome: "TESTE_MODAL", operadoraId: vodafone.id }).returning();
    ofertaId = oferta.id;
    const [e] = await db.insert(s.orgEmpresas).values({ nome: "[TESTE] modal", pipedriveCompanyId: COMPANY, pipedriveApiToken: "tok-modal" }).returning();
    empresaId = e.id;
    await db.insert(s.orgEmpresaPipedriveFieldMap).values([
      { empresaId, chaveLogica: "pricing_plan_id", pipedriveFieldKey: "ppidk" },
      { empresaId, chaveLogica: "id_simulador", pipedriveFieldKey: "simk" },
    ]);
    await db.insert(s.refObjetivos).values([
      { empresaId, operadoraId: vodafone.id, nome: "Nova RLMC Móvel", idFunilPipedrive: FUNIL_MOVEL, idTipoReceita: 1, atingimentoLinha: "GSM" },
      { empresaId, operadoraId: vodafone.id, nome: "Nova RLMC Fixo", idFunilPipedrive: FUNIL_FIXO, idTipoReceita: 1, atingimentoLinha: "Fixo" },
    ]);
    await db.insert(s.refProdutosVodafone).values([
      { pricingPlanId: "970000001", ofertaId, nome: "Red Pro", atingimentoNova: "GSM", hashConteudo: Buffer.from([1]) },
      { pricingPlanId: "970000002", ofertaId, nome: "Net Fibra", atingimentoNova: "FIXO", hashConteudo: Buffer.from([2]) },
      { pricingPlanId: "970000003", ofertaId, nome: "3P Biz Start", atingimentoNova: "GSM", hashConteudo: Buffer.from([3]) },
    ]);
    await db.insert(s.orgPipedriveOauthTokens).values({
      empresaId,
      pipedriveUserId: PD_USER,
      pipedriveCompanyId: COMPANY,
      accessTokenCiphertext: cifrar("acc-modal"),
      refreshTokenCiphertext: cifrar("ref-modal"),
      apiDomain: "https://x.pipedrive.com",
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    // O Pipedrive simulado
    let proximoId = 70000;
    vi.stubGlobal("fetch", async (alvo: string | URL, init?: RequestInit) => {
      const u = new URL(String(alvo));
      const metodo = init?.method ?? "GET";
      const corpo = typeof init?.body === "string" ? init.body : null;
      pedidos.push({ metodo, caminho: u.pathname + (u.pathname === "/v1/deals/search" ? u.search : ""), corpo });
      const ok = (data: unknown, extra: object = {}) => Response.json({ success: true, data, ...extra });
      if (u.pathname === "/v1/products")
        return ok(
          [
            { id: 11, name: "Red Pro", ppidk: "970000001" },
            { id: 12, name: "Net Fibra", ppidk: 970000002 },
            { id: 13, name: "3P Biz Start", ppidk: "970000003" },
            { id: 14, name: "Local sem PPID", ppidk: null },
          ],
          { additional_data: { pagination: { more_items_in_collection: false } } },
        );
      if (u.pathname === "/v1/deals/search") return ok({ items: pesquisa });
      if (u.pathname === `/v1/deals/${DEAL}` && metodo === "GET")
        return ok({ id: DEAL, title: "Cliente X", pipeline_id: FUNIL_MOVEL, person_id: { name: "Ana", value: 7 }, org_id: { name: "X Lda", value: 8 } });
      if (/^\/v1\/deals\/\d+$/.test(u.pathname) && metodo === "PUT") return ok({ id: Number(u.pathname.split("/")[3]) });
      if (/^\/v1\/deals\/\d+\/products$/.test(u.pathname) && metodo === "POST") return ok({ id: proximoId++ });
      if (u.pathname === "/v1/deals" && metodo === "POST") return ok({ id: 9900 });
      return new Response("não esperado", { status: 500 });
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!empresaId) return;
    const db = dbm.db;
    await db.delete(s.sysContratoUploads).where(d.eq(s.sysContratoUploads.empresaId, empresaId));
    await db.delete(s.orgPipedriveOauthTokens).where(d.eq(s.orgPipedriveOauthTokens.empresaId, empresaId));
    await db.delete(s.refProdutosVodafone).where(d.eq(s.refProdutosVodafone.ofertaId, ofertaId));
    await db.delete(s.refObjetivos).where(d.eq(s.refObjetivos.empresaId, empresaId));
    await db.delete(s.orgEmpresaPipedriveFieldMap).where(d.eq(s.orgEmpresaPipedriveFieldMap.empresaId, empresaId));
    await db.delete(s.orgEmpresas).where(d.eq(s.orgEmpresas.id, empresaId));
    await db.delete(s.refOfertas).where(d.eq(s.refOfertas.id, ofertaId));
  });

  it("extract: resolve por PPID e por nome, classifica por funil e explica as ignoradas", async () => {
    linhasDoClaude.atual = [
      { nomeProduto: "Red Pro", quantidade: 2, duracaoContratoMeses: 24, multaMensal: NetDecimal.de("22.50"), pricingPlanId: "970000001" },
      { nomeProduto: "3P BIZ START", quantidade: 1, duracaoContratoMeses: 36, multaMensal: NetDecimal.de("40"), pricingPlanId: null },
      { nomeProduto: "Net Fibra", quantidade: 1, duracaoContratoMeses: 24, multaMensal: NetDecimal.de("30.00"), pricingPlanId: "970000002" },
      { nomeProduto: "Desconto", quantidade: 1, duracaoContratoMeses: 0, multaMensal: NetDecimal.de("0"), pricingPlanId: null },
    ];
    const r = await rotas.extract(await pedido("/pipedrive/contract/extract", { rawText: "texto do simulador", dealId: DEAL }));
    expect(r.status).toBe(200);
    const corpo = await r.text();
    expect(corpo).toContain('"multaMensal":22.50'); // o dinheiro com as casas, como o C#
    const p = JSON.parse(corpo);
    expect(p).toMatchObject({ classificacaoAtiva: true, objetivoDoNegocio: "Nova RLMC Móvel", tituloNegocio: "Cliente X" });
    expect(p.linhas.map((l: Record<string, unknown>) => [l.nomeProduto, l.status, l.origemResolucao, l.pipedriveProductId, l.classificacao])).toEqual([
      ["Red Pro", "ok", "ppid", 11, "pertence"],
      ["3P BIZ START", "ok", "nome", 13, "pertence"],
      ["Net Fibra", "ok", "ppid", 12, "outro_funil"],
    ]);
    expect(p.linhas[2].funisAlvo).toEqual([{ idFunil: FUNIL_FIXO, objetivo: "Nova RLMC Fixo", nomeFunil: null, sugerido: true }]);
    expect(p.linhasIgnoradas).toEqual([{ nomeProduto: "Desconto", motivo: "Sem contrato de permanência nem multa mensal — não gera comissão." }]);
  });

  it("apply: recusa a linha de outro funil sem motivo; com motivo grava id_simulador, produtos e auditoria", async () => {
    const linhas = [
      { nomeProduto: "Red Pro", quantidade: 2, duracaoMeses: 24, multaMensal: 22.5, pricingPlanId: "970000001", pipedriveProductId: 11, numerosAssociados: ["911111111", "922222222"] },
      { nomeProduto: "Net Fibra", quantidade: 1, duracaoMeses: 24, multaMensal: 30, pricingPlanId: "970000002", pipedriveProductId: 12, numerosAssociados: [] },
    ];
    const recusa = await rotas.apply(await pedido("/pipedrive/contract/apply", { idSimulacao: "SIM-9", dealId: DEAL, linhas }));
    expect(recusa.status).toBe(400);
    expect((await recusa.json()).error).toContain("Net Fibra");

    // PPID com produto trocado: recusado
    const trocado = await rotas.apply(await pedido("/pipedrive/contract/apply", { idSimulacao: "SIM-9", dealId: DEAL, linhas: [{ ...linhas[0], pipedriveProductId: 13 }] }));
    expect(trocado.status).toBe(400);

    pedidos.length = 0;
    const comMotivo = [linhas[0], { ...linhas[1], motivoForaDoFunil: "Aceite pela Vodafone neste caso" }];
    const r = await rotas.apply(await pedido("/pipedrive/contract/apply", { rawText: "texto", idSimulacao: " SIM-9 ", dealId: DEAL, linhas: comMotivo }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "success", errors: [] });

    const escritas = pedidos.filter((p) => p.metodo !== "GET");
    expect(escritas.map((p) => `${p.metodo} ${p.caminho}`)).toEqual([`PUT /v1/deals/${DEAL}`, `POST /v1/deals/${DEAL}/products`, `POST /v1/deals/${DEAL}/products`]);
    expect(JSON.parse(escritas[0].corpo!)).toEqual({ simk: "SIM-9" }); // o id_simulador primeiro
    const red = JSON.parse(escritas[1].corpo!);
    expect(red).toMatchObject({ product_id: 11, quantity: 2, item_price: 22.5 });
    const { lerSubscricoes } = await import("@/lib/calculo");
    expect(lerSubscricoes(red.comments)).toEqual([
      { numero: "911111111", duracaoMeses: 24, quantidade: 1 },
      { numero: "922222222", duracaoMeses: 24, quantidade: 1 },
    ]);

    const [audit] = await dbm.db.select().from(s.sysContratoUploads).where(d.eq(s.sysContratoUploads.empresaId, empresaId));
    expect(audit).toMatchObject({ pipedriveDealId: DEAL, idSimulacao: " SIM-9 ", appliedStatus: "success", linhasExtraidas: 2, parseStatus: "success" });
    expect(JSON.parse(audit.payloadJson!).foraDoFunil).toEqual([
      { pricingPlanId: "970000002", nomeProduto: "Net Fibra", atingimento: "FIXO", motivo: "Aceite pela Vodafone neste caso" },
    ]);
  });

  it("criar-negocio: recusa duplicado no mesmo funil; senão cria com o contacto da origem", async () => {
    const linha = { nomeProduto: "Net Fibra", quantidade: 1, duracaoMeses: 24, multaMensal: "30.00", pricingPlanId: "970000002", pipedriveProductId: 12, numerosAssociados: [] };
    const base = { idSimulacao: "SIM-9", dealOrigemId: DEAL, pipelineId: FUNIL_FIXO, titulo: "Cliente X — Fixo", linhas: [linha] };

    pesquisa = [{ item: { id: 8888, title: "já existe", pipeline: { id: FUNIL_FIXO } } }];
    const dup = await rotas.criarNegocioIrmao(await pedido("/pipedrive/contract/criar-negocio", base));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ dealId: 8888 });

    // Produto que não é deste funil: recusado
    pesquisa = [];
    const errado = await rotas.criarNegocioIrmao(await pedido("/pipedrive/contract/criar-negocio", { ...base, pipelineId: FUNIL_MOVEL }));
    expect(errado.status).toBe(400);

    pedidos.length = 0;
    const r = await rotas.criarNegocioIrmao(await pedido("/pipedrive/contract/criar-negocio", base));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "success", dealId: 9900 });
    const criacao = pedidos.find((p) => p.metodo === "POST" && p.caminho === "/v1/deals")!;
    expect(JSON.parse(criacao.corpo!)).toEqual({ title: "Cliente X — Fixo", pipeline_id: FUNIL_FIXO, person_id: 7, org_id: 8, simk: "SIM-9" });
    expect(criacao.corpo).not.toBeNull();
    expect(pedidos.find((p) => p.caminho === "/v1/deals/9900/products")?.corpo).toContain('"item_price":30.00');
  });

  it("catalog e sessão", async () => {
    const cat = await rotas.catalogo(await pedido("/pipedrive/catalog"));
    expect(await cat.json()).toEqual([
      { productId: 13, nome: "3P Biz Start", pricingPlanId: "970000003" },
      { productId: 12, nome: "Net Fibra", pricingPlanId: "970000002" },
      { productId: 11, nome: "Red Pro", pricingPlanId: "970000001" },
    ]);
    const sessao = await (await rotas.estenderSessao(await pedido("/pipedrive/session/extend", {}))).json();
    expect(sessao.expiresInSeconds).toBe(1800);
    const { validarJwtModal, configOAuth } = await import("@/lib/pipedrive/oauth");
    expect(await validarJwtModal(sessao.token, configOAuth()!)).toMatchObject({ pipedriveUserId: PD_USER, pipedriveCompanyId: COMPANY });
  });

  it("sem JWT válido: 401; conta Pipedrive sem empresa: 403", async () => {
    const sem = await rotas.catalogo(new Request("https://app.exemplo.test/pipedrive/catalog"));
    expect(sem.status).toBe(401);
    const outra = await new SignJWT({ user_id: 1, company_id: 1 }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(new TextEncoder().encode(process.env.PIPEDRIVE_CLIENT_SECRET));
    const r = await rotas.catalogo(new Request("https://app.exemplo.test/pipedrive/catalog", { headers: { Authorization: `Bearer ${outra}` } }));
    expect(r.status).toBe(403);
  });
});
