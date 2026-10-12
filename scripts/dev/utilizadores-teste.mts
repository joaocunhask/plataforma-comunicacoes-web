// Utilizadores de TESTE para experimentar o login na BD de desenvolvimento.
//
//   npm run dev:utilizadores-teste            cria (ou recria) os utilizadores de teste
//   npm run dev:utilizadores-teste -- --apagar remove-os (o ETL exige a BD vazia)
//
// Só mexe nas linhas que ele próprio cria (empresas "[TESTE] …", emails @exemplo.test) e
// recusa correr se a BD já tiver empresas reais. A password e a chave do autenticador
// ficam no .env.local (DEV_TESTE_PASSWORD, DEV_TESTE_CHAVE_2FA), nunca no código.

import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { inArray, like, not } from "drizzle-orm";
import { db } from "../../src/db/index";
import { aspNetUsers, aspNetUserTokens, authContas, orgEmpresas, orgMembros } from "../../src/db/schema";
import { hashPasswordIdentity } from "../../src/lib/identity/password";
import { gerarChaveAutenticador } from "../../src/lib/identity/totp";

const PREFIXO_EMPRESA = "[TESTE] ";
const DOMINIO = "@exemplo.test";

const empresasReais = await db
  .select({ id: orgEmpresas.id })
  .from(orgEmpresas)
  .where(not(like(orgEmpresas.nome, `${PREFIXO_EMPRESA}%`)));
if (empresasReais.length > 0) {
  console.error("A BD tem empresas reais: os utilizadores de teste só se criam numa BD de desenvolvimento.");
  process.exit(1);
}

async function apagar() {
  const utilizadores = await db.select({ id: aspNetUsers.id }).from(aspNetUsers).where(like(aspNetUsers.email, `%${DOMINIO}`));
  const ids = utilizadores.map((u) => u.id);
  if (ids.length > 0) {
    await db.delete(orgMembros).where(inArray(orgMembros.aspnetUserId, ids));
    await db.delete(aspNetUsers).where(inArray(aspNetUsers.id, ids)); // sessões, contas e tokens vão em cascata
  }
  await db.delete(orgEmpresas).where(like(orgEmpresas.nome, `${PREFIXO_EMPRESA}%`));
  return ids.length;
}

if (process.argv.includes("--apagar")) {
  console.log(`Removidos ${await apagar()} utilizadores de teste e as empresas [TESTE].`);
  process.exit(0);
}

await apagar();

const password = process.env.DEV_TESTE_PASSWORD ?? randomBytes(12).toString("base64url");
const chave2fa = process.env.DEV_TESTE_CHAVE_2FA ?? gerarChaveAutenticador();
if (!process.env.DEV_TESTE_PASSWORD) {
  appendFileSync(".env.local", `\n# Utilizadores de teste (scripts/dev/utilizadores-teste.mts)\nDEV_TESTE_PASSWORD=${password}\nDEV_TESTE_CHAVE_2FA=${chave2fa}\n`);
}

/** Um hash V2 do Identity (PBKDF2-SHA1, 1000 iterações), para ver o rehash no login. */
function hashV2(p: string): string {
  const salt = randomBytes(16);
  return Buffer.concat([Buffer.from([0x00]), salt, pbkdf2Sync(p, salt, 1000, 32, "sha1")]).toString("base64");
}

const [empresaA, empresaB] = await db
  .insert(orgEmpresas)
  .values([{ nome: `${PREFIXO_EMPRESA}Empresa A` }, { nome: `${PREFIXO_EMPRESA}Empresa B` }])
  .returning({ id: orgEmpresas.id });

const casos = [
  { nome: "simples", empresas: [empresaA.id], dois: false, ativo: true, v2: false },
  { nome: "2fa", empresas: [empresaA.id, empresaB.id], dois: true, ativo: true, v2: false },
  { nome: "sem-empresa", empresas: [], dois: false, ativo: true, v2: false },
  { nome: "por-ativar", empresas: [empresaA.id], dois: false, ativo: false, v2: false },
  { nome: "hash-v2", empresas: [empresaA.id], dois: false, ativo: true, v2: true },
];

for (const c of casos) {
  const id = randomUUID();
  const email = `teste.${c.nome}${DOMINIO}`;
  await db.insert(aspNetUsers).values({
    id,
    userName: email,
    normalizedUserName: email.toUpperCase(),
    email,
    normalizedEmail: email.toUpperCase(),
    emailConfirmed: c.ativo,
    passwordHash: null, // a password vive em auth_contas
    securityStamp: randomUUID(),
    concurrencyStamp: randomUUID(),
    phoneNumberConfirmed: false,
    twoFactorEnabled: c.dois,
    lockoutEnabled: true,
    accessFailedCount: 0,
  });
  await db.insert(authContas).values({
    id: randomUUID(),
    accountId: id,
    providerId: "credential",
    userId: id,
    password: c.v2 ? hashV2(password) : await hashPasswordIdentity(password),
  });
  if (c.dois) {
    await db.insert(aspNetUserTokens).values({ userId: id, loginProvider: "[AspNetUserStore]", name: "AuthenticatorKey", value: chave2fa });
  }
  for (const empresaId of c.empresas) await db.insert(orgMembros).values({ aspnetUserId: id, empresaId });
  console.log(`${email}${c.dois ? " (2FA)" : ""}${c.ativo ? "" : " (por ativar)"} — empresas: ${c.empresas.length}`);
}
console.log("Password e chave 2FA no .env.local (DEV_TESTE_PASSWORD, DEV_TESTE_CHAVE_2FA).");
