// Leituras e escritas da autenticação que o Better Auth não faz por si: o bloqueio de conta
// (colunas Lockout*/AccessFailedCount do AspNetUsers), a chave do autenticador
// (AspNetUserTokens) e as empresas a que o utilizador pode entrar.
import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { aspNetUsers, aspNetUserTokens, authContas, orgEmpresas, orgMembros } from "@/db/schema";
import { type EstadoBloqueio, hashPasswordIdentity, limparFalhas, precisaDeRehash, registarFalha } from "@/lib/identity";

export interface UtilizadorAuth extends EstadoBloqueio {
  id: string;
  twoFactorEnabled: boolean;
  concurrencyStamp: string | null;
}

const colunasUtilizador = {
  id: aspNetUsers.id,
  lockoutEnabled: aspNetUsers.lockoutEnabled,
  lockoutEnd: aspNetUsers.lockoutEnd,
  accessFailedCount: aspNetUsers.accessFailedCount,
  twoFactorEnabled: aspNetUsers.twoFactorEnabled,
  concurrencyStamp: aspNetUsers.concurrencyStamp,
};

/** Pelo email em minúsculas, como o Better Auth o procura. */
export async function utilizadorPorEmail(email: string): Promise<UtilizadorAuth | null> {
  const [u] = await db.select(colunasUtilizador).from(aspNetUsers).where(eq(aspNetUsers.email, email.toLowerCase()));
  return u ?? null;
}

export async function utilizadorPorId(id: string): Promise<UtilizadorAuth | null> {
  const [u] = await db.select(colunasUtilizador).from(aspNetUsers).where(eq(aspNetUsers.id, id));
  return u ?? null;
}

/**
 * Grava o novo estado do bloqueio com concorrência otimista pelo ConcurrencyStamp, como o
 * UserManager do Identity: se outro pedido mexeu no utilizador entretanto, relê e repete.
 */
async function atualizarBloqueio(userId: string, alterar: (estado: EstadoBloqueio) => EstadoBloqueio): Promise<void> {
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const atual = await utilizadorPorId(userId);
    if (!atual) return;
    const novo = alterar(atual);
    if (novo === atual) return; // nada a mudar
    const atualizados = await db
      .update(aspNetUsers)
      .set({
        lockoutEnd: novo.lockoutEnd,
        accessFailedCount: novo.accessFailedCount,
        concurrencyStamp: randomUUID(),
      })
      .where(
        and(
          eq(aspNetUsers.id, userId),
          sql`${aspNetUsers.concurrencyStamp} IS NOT DISTINCT FROM ${atual.concurrencyStamp}`,
        ),
      )
      .returning({ id: aspNetUsers.id });
    if (atualizados.length > 0) return;
  }
  throw new Error(`Não foi possível atualizar o bloqueio do utilizador ${userId} (concorrência).`);
}

/** AccessFailedAsync: password ou código 2FA errado. */
export function registarTentativaFalhada(userId: string, agora = new Date()): Promise<void> {
  return atualizarBloqueio(userId, (estado) => registarFalha(estado, agora));
}

/** ResetAccessFailedCountAsync: depois de uma password ou código certos. */
export function limparTentativasFalhadas(userId: string): Promise<void> {
  return atualizarBloqueio(userId, limparFalhas);
}

/** A chave do autenticador, onde o Identity a guarda. */
export async function chaveDoAutenticador(userId: string): Promise<string | null> {
  const [t] = await db
    .select({ valor: aspNetUserTokens.value })
    .from(aspNetUserTokens)
    .where(
      and(
        eq(aspNetUserTokens.userId, userId),
        eq(aspNetUserTokens.loginProvider, "[AspNetUserStore]"),
        eq(aspNetUserTokens.name, "AuthenticatorKey"),
      ),
    );
  return t?.valor ?? null;
}

export interface EmpresaDoUtilizador {
  id: number;
  nome: string;
}

/** As empresas ativas em que o utilizador é membro não bloqueado (MinhasEmpresasAsync). */
export async function empresasDoUtilizador(userId: string): Promise<EmpresaDoUtilizador[]> {
  return db
    .selectDistinct({ id: orgEmpresas.id, nome: orgEmpresas.nome })
    .from(orgMembros)
    .innerJoin(orgEmpresas, eq(orgEmpresas.id, orgMembros.empresaId))
    .where(and(eq(orgMembros.aspnetUserId, userId), eq(orgEmpresas.ativo, true), eq(orgMembros.bloqueado, false)))
    .orderBy(asc(orgEmpresas.nome));
}

/**
 * Depois de uma password certa: se o hash usa parâmetros antigos, regrava-o com os atuais
 * (o que o UserManager.CheckPasswordAsync faz ao receber SuccessRehashNeeded).
 */
export async function regravarPasswordSePreciso(userId: string, password: string): Promise<void> {
  const [conta] = await db
    .select({ id: authContas.id, password: authContas.password })
    .from(authContas)
    .where(and(eq(authContas.userId, userId), eq(authContas.providerId, "credential")));
  if (!conta?.password || !precisaDeRehash(conta.password)) return;
  await db
    .update(authContas)
    .set({ password: await hashPasswordIdentity(password), updatedAt: new Date() })
    .where(eq(authContas.id, conta.id));
}
