// OAuth do Pipedrive: state, JWT do modal, cifra dos tokens e o fluxo de troca contra o
// Postgres local (com o Pipedrive simulado). Sem BD local, a parte de BD é saltada.
import { config } from "dotenv";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

config({ path: ".env.local", quiet: true });
process.env.PIPEDRIVE_CLIENT_ID = "cliente-teste";
process.env.PIPEDRIVE_CLIENT_SECRET = "segredo-de-teste-com-pelo-menos-32-bytes!!";
process.env.PIPEDRIVE_CALLBACK_URL = "https://app.exemplo.test/oauth/pipedrive/callback";
process.env.PIPEDRIVE_TOKENS_KEY = Buffer.alloc(32, 7).toString("base64");

const oauth = await import("@/lib/pipedrive/oauth");
const cfg = oauth.configOAuth()!;
const segredo = new TextEncoder().encode(cfg.clientSecret);
const jwtModal = (claims: Record<string, unknown>, exp: string | number = "5m", chave = segredo) =>
  new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setExpirationTime(exp).sign(chave);

describe("JWT do modal", () => {
  it("aceita o do Pipedrive e normaliza as claims", async () => {
    expect(await oauth.validarJwtModal(await jwtModal({ user_id: 15, company_id: 900, deal_id: 77 }), cfg)).toEqual({
      pipedriveUserId: 15,
      pipedriveCompanyId: 900,
      pipedriveDealId: 77,
    });
    expect(await oauth.validarJwtModal(await jwtModal({ userId: "15", companyId: "900" }), cfg)).toMatchObject({ pipedriveDealId: null });
  });

  it("recusa assinatura errada, expirado, sem exp e sem ids", async () => {
    expect(await oauth.validarJwtModal(await jwtModal({ user_id: 1, company_id: 2 }, "5m", new TextEncoder().encode("outro")), cfg)).toBeNull();
    expect(await oauth.validarJwtModal(await jwtModal({ user_id: 1, company_id: 2 }, Math.floor(Date.now() / 1000) - 600), cfg)).toBeNull();
    const semExp = await new SignJWT({ user_id: 1, company_id: 2 }).setProtectedHeader({ alg: "HS256" }).sign(segredo);
    expect(await oauth.validarJwtModal(semExp, cfg)).toBeNull();
    expect(await oauth.validarJwtModal(await jwtModal({ company_id: 2 }), cfg)).toBeNull();
    expect(await oauth.validarJwtModal("lixo", cfg)).toBeNull();
  });

  it("lê o token da query ou do Bearer", () => {
    expect(oauth.tokenDoModal(new Request("https://x.test/p?token=abc"))).toBe("abc");
    expect(oauth.tokenDoModal(new Request("https://x.test/p", { headers: { Authorization: "Bearer def" } }))).toBe("def");
    expect(oauth.tokenDoModal(new Request("https://x.test/p"))).toBeNull();
  });
});

describe("state", () => {
  it("assina e valida; outra chave ou lixo não passam", async () => {
    const s = await oauth.assinarState(cfg, 15, 900);
    expect(await oauth.validarState(s, cfg)).toMatchObject({ pipedriveUserId: 15, pipedriveCompanyId: 900 });
    expect(await oauth.validarState(s, { ...cfg, clientSecret: "outra-chave-qualquer-com-32-bytes!!!" })).toBeNull();
    expect(await oauth.validarState("nao.e.jwt", cfg)).toBeNull();
    expect(new URL(oauth.urlDeAutorizacao(cfg, s)).searchParams.get("redirect_uri")).toBe(cfg.callbackUrl);
  });
});

describe("cifra dos tokens", () => {
  it("ida e volta; texto alterado, outro formato (Data Protection) ou outra chave → null", () => {
    const c = oauth.cifrar("access-123");
    expect(oauth.decifrar(c)).toBe("access-123");
    const adulterado = Buffer.from(c);
    adulterado[adulterado.length - 1] ^= 1;
    expect(oauth.decifrar(adulterado)).toBeNull();
    expect(oauth.decifrar(Buffer.from([0x09, 0xf0, 0xc9, 0xdb, ...Array(60).fill(1)]))).toBeNull();
    process.env.PIPEDRIVE_TOKENS_KEY = Buffer.alloc(32, 8).toString("base64");
    expect(oauth.decifrar(c)).toBeNull();
    process.env.PIPEDRIVE_TOKENS_KEY = Buffer.alloc(32, 7).toString("base64");
  });
});

const url = process.env.DATABASE_URL;
const local = !!url && ["localhost", "127.0.0.1"].includes(new URL(url).hostname);

describe.skipIf(!local)("troca do code com a BD", () => {
  const COMPANY = 987_654_321;
  let empresaId: number;
  let dbm: typeof import("@/db");
  let s: typeof import("@/db/schema");
  let drizzle: typeof import("drizzle-orm");
  let respostaToken = { access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600, api_domain: "https://x.pipedrive.com", scope: "deals:full" };
  let codigoToken = 200;
  let utilizador = { id: 15, company_id: COMPANY };

  beforeAll(async () => {
    dbm = await import("@/db");
    s = await import("@/db/schema");
    drizzle = await import("drizzle-orm");
    const [e] = await dbm.db.insert(s.orgEmpresas).values({ nome: "[TESTE] oauth", pipedriveCompanyId: COMPANY }).returning();
    empresaId = e.id;
    vi.stubGlobal("fetch", async (alvo: string | URL) => {
      const u = String(alvo);
      if (u.startsWith("https://oauth.pipedrive.com/oauth/token"))
        return new Response(JSON.stringify(respostaToken), { status: codigoToken });
      if (u.includes("/v1/users/me")) return Response.json({ success: true, data: { ...utilizador, name: "Teste" } });
      return new Response("não esperado", { status: 500 });
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!empresaId) return;
    await dbm.db.delete(s.orgPipedriveOauthTokens).where(drizzle.eq(s.orgPipedriveOauthTokens.empresaId, empresaId));
    await dbm.db.delete(s.orgEmpresas).where(drizzle.eq(s.orgEmpresas.id, empresaId));
    await dbm.db.delete(s.authVerificacoes).where(drizzle.eq(s.authVerificacoes.identifier, "pd-oauth-jti"));
  });

  it("instala, recusa replay e conta trocada, renova e revoga", async () => {
    const { trocar } = await import("@/lib/pipedrive/rotas-oauth");
    const tokens = () => dbm.db.select().from(s.orgPipedriveOauthTokens).where(drizzle.eq(s.orgPipedriveOauthTokens.empresaId, empresaId));

    // Instalação a partir do Pipedrive (sem state)
    expect(await trocar("code-1", null)).toEqual({ ok: true });
    let [linha] = await tokens();
    expect(linha).toMatchObject({ pipedriveUserId: 15, pipedriveCompanyId: COMPANY, apiDomain: "https://x.pipedrive.com", revogadoEm: null });
    expect(linha.accessTokenCiphertext.includes(Buffer.from("acc-1"))).toBe(false); // guardado cifrado
    expect(await oauth.tokenValido(cfg, empresaId, 15)).toMatchObject({ accessToken: "acc-1" });

    // A partir do modal: o state vale uma vez, e só para a mesma conta
    const state = await oauth.assinarState(cfg, 15, COMPANY);
    expect(await trocar("code-2", state)).toEqual({ ok: true });
    expect(await trocar("code-3", state)).toMatchObject({ ok: false, status: 400, erro: "State já utilizado." });
    expect(await trocar("code-4", await oauth.assinarState(cfg, 99, COMPANY))).toMatchObject({ ok: false, status: 403 });
    expect(await tokens()).toHaveLength(1); // a mesma linha, renovada

    // Conta Pipedrive sem empresa registada
    utilizador = { id: 15, company_id: 1 };
    expect(await trocar("code-5", null)).toMatchObject({ ok: false, status: 403 });
    utilizador = { id: 15, company_id: COMPANY };

    // Expirado → refresh
    await dbm.db.update(s.orgPipedriveOauthTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(drizzle.eq(s.orgPipedriveOauthTokens.id, linha.id));
    respostaToken = { ...respostaToken, access_token: "acc-2", refresh_token: "ref-2" };
    expect(await oauth.tokenValido(cfg, empresaId, 15)).toMatchObject({ accessToken: "acc-2" });

    // Refresh recusado → revogado
    await dbm.db.update(s.orgPipedriveOauthTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(drizzle.eq(s.orgPipedriveOauthTokens.id, linha.id));
    codigoToken = 400;
    expect(await oauth.tokenValido(cfg, empresaId, 15)).toBeNull();
    [linha] = await tokens();
    expect(linha.revogadoEm).not.toBeNull();
    codigoToken = 200;

    // Token do .NET (Data Protection) não decifra → revogado, e uma nova autorização cria outra linha
    await dbm.db.insert(s.orgPipedriveOauthTokens).values({
      empresaId,
      pipedriveUserId: 16,
      pipedriveCompanyId: COMPANY,
      accessTokenCiphertext: Buffer.from([0x09, 0xf0, 0xc9, 0xdb, 1, 2, 3]),
      refreshTokenCiphertext: Buffer.from([0x09, 0xf0, 0xc9, 0xdb, 4, 5, 6]),
      apiDomain: "https://x.pipedrive.com",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(await oauth.tokenValido(cfg, empresaId, 16)).toBeNull();
    utilizador = { id: 16, company_id: COMPANY };
    expect(await trocar("code-6", null)).toEqual({ ok: true });
    expect(await oauth.tokenValido(cfg, empresaId, 16)).toMatchObject({ accessToken: "acc-2" });
  });
});
