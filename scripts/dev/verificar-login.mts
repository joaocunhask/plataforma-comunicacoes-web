// Verificação de ponta a ponta do login contra o servidor de desenvolvimento (npm run dev),
// com os utilizadores de teste (npm run dev:utilizadores-teste). Recria-os no fim, porque
// o teste do bloqueio deixa um utilizador bloqueado.
//   npm run dev:verificar-login
import { execSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index";
import { aspNetUsers, authContas, authSessoes } from "../../src/db/schema";

const BASE = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const PASSWORD = process.env.DEV_TESTE_PASSWORD!;

async function entrar(email: string, password: string) {
  const r = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  const corpo = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  // Os cookies de sessão que ficam válidos (um Max-Age=0 é o servidor a apagá-los).
  const cookiesSessao = r.headers
    .getSetCookie()
    .filter((c) => c.startsWith("better-auth.session_token=") && !/max-age=0/i.test(c))
    .map((c) => c.split(";")[0].split("=")[0]);
  return { status: r.status, codigo: corpo.code, corpo, cookiesSessao };
}

async function utilizador(email: string) {
  const [u] = await db
    .select({ id: aspNetUsers.id, falhas: aspNetUsers.accessFailedCount, bloqueadoAte: aspNetUsers.lockoutEnd })
    .from(aspNetUsers)
    .where(eq(aspNetUsers.email, email));
  return u;
}

const resultados: [string, boolean, string][] = [];
const verificar = (nome: string, ok: boolean, detalhe: unknown) => resultados.push([nome, ok, JSON.stringify(detalhe)]);

// Sem empresa: password certa, mas o login é recusado e não fica sessão (nem cookie nem BD).
{
  const email = "teste.sem-empresa@exemplo.test";
  const r = await entrar(email, PASSWORD);
  const sessoes = await db.select({ id: authSessoes.id }).from(authSessoes).where(eq(authSessoes.userId, (await utilizador(email)).id));
  verificar(
    "sem empresa → 403 SEM_EMPRESA, sem sessão",
    r.status === 403 && r.codigo === "SEM_EMPRESA" && r.cookiesSessao.length === 0 && sessoes.length === 0,
    { ...r, sessoes: sessoes.length },
  );
}

// Conta por ativar (EmailConfirmed = false).
{
  const r = await entrar("teste.por-ativar@exemplo.test", PASSWORD);
  verificar("por ativar → 403 EMAIL_NOT_VERIFIED", r.status === 403 && r.codigo === "EMAIL_NOT_VERIFIED", r);
}

// Hash V2 antigo: entra e o hash fica regravado em V3 (SHA512, 100 000 iterações).
{
  const email = "teste.hash-v2@exemplo.test";
  const u = await utilizador(email);
  const antes = (await db.select({ p: authContas.password }).from(authContas).where(eq(authContas.userId, u.id)))[0].p!;
  const r = await entrar(email, PASSWORD);
  const depois = (await db.select({ p: authContas.password }).from(authContas).where(eq(authContas.userId, u.id)))[0].p!;
  const cabecalho = Buffer.from(depois, "base64").subarray(0, 13).toString("hex");
  verificar(
    "hash V2 → entra e fica V3 SHA512 100k",
    r.status === 200 && Buffer.from(antes, "base64")[0] === 0 && cabecalho === "0100000002000186a000000010",
    { status: r.status, cabecalho },
  );
}

// Código 2FA sem ter passado pela password.
{
  const r = await fetch(`${BASE}/api/auth/compat-identity/2fa/verificar`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ codigo: "123456" }),
  });
  const corpo = (await r.json()) as { code?: string };
  verificar("código 2FA sem desafio → 401 DESAFIO_2FA_INVALIDO", r.status === 401 && corpo.code === "DESAFIO_2FA_INVALIDO", corpo);
}

// Teto de 12 h: uma sessão iniciada há 13 h é apagada no pedido seguinte, mesmo com atividade.
{
  // Só a sessão deste teste (o caso do hash V2 acima deixou outra).
  await db.delete(authSessoes).where(eq(authSessoes.userId, (await utilizador("teste.hash-v2@exemplo.test")).id));
  const r = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: "teste.hash-v2@exemplo.test", password: PASSWORD }),
  });
  const cookie = r.headers
    .getSetCookie()
    .filter((c) => c.startsWith("better-auth.session_token="))
    .map((c) => c.split(";")[0])
    .join("; ");
  const u = await utilizador("teste.hash-v2@exemplo.test");
  await db.update(authSessoes).set({ createdAt: new Date(Date.now() - 13 * 3600_000) }).where(eq(authSessoes.userId, u.id));
  await (await fetch(`${BASE}/`, { headers: { cookie } })).text();
  const restantes = await db.select({ id: authSessoes.id }).from(authSessoes).where(eq(authSessoes.userId, u.id));
  verificar("sessão com mais de 12 h é apagada no pedido seguinte", r.status === 200 && restantes.length === 0, { login: r.status, restantes: restantes.length });
}

// Bloqueio: 5 passwords erradas bloqueiam 15 min; depois nem a certa entra.
{
  const email = "teste.simples@exemplo.test";
  for (let i = 1; i <= 4; i++) await entrar(email, "errada");
  const aos4 = await utilizador(email);
  verificar("4 falhas → contador 4, sem bloqueio", aos4.falhas === 4 && aos4.bloqueadoAte === null, aos4);
  await entrar(email, "errada");
  const aos5 = await utilizador(email);
  const minutos = aos5.bloqueadoAte ? (aos5.bloqueadoAte.getTime() - Date.now()) / 60000 : 0;
  verificar("5.ª falha → bloqueado ~15 min e contador a 0", aos5.falhas === 0 && minutos > 14.5 && minutos <= 15, { falhas: aos5.falhas, minutos });
  const r = await entrar(email, PASSWORD);
  verificar("bloqueado → nem a password certa entra (403 CONTA_BLOQUEADA)", r.status === 403 && r.codigo === "CONTA_BLOQUEADA", r);
}

// A falha do código errado no teste do browser foi limpa pelo código certo.
{
  const u = await utilizador("teste.2fa@exemplo.test");
  verificar("2FA: código certo limpa as falhas", u.falhas === 0, u);
}

for (const [nome, ok, detalhe] of resultados) console.log(`${ok ? "OK  " : "FALHOU"}  ${nome}${ok ? "" : `  ${detalhe}`}`);
execSync("npm run --silent dev:utilizadores-teste", { stdio: "ignore" });
console.log("(utilizadores de teste recriados)");
process.exit(resultados.every(([, ok]) => ok) ? 0 : 1);
