// Bloqueio de conta por tentativas falhadas, como o UserManager do Identity com as opções
// da API .NET (Program.cs): 5 falhas seguidas → bloqueado 15 minutos. Conta tanto a
// password errada como o código 2FA errado.
//
// Port de UserManager.IsLockedOutAsync / AccessFailedAsync / ResetAccessFailedCountAsync.
// Funções puras sobre o estado (as colunas de AspNetUsers); quem chama grava o resultado.

export const MAX_TENTATIVAS_FALHADAS = 5;
export const DURACAO_BLOQUEIO_MS = 15 * 60 * 1000;

export interface EstadoBloqueio {
  /** AspNetUsers.LockoutEnabled — false: o utilizador nunca fica bloqueado. */
  lockoutEnabled: boolean;
  /** AspNetUsers.LockoutEnd — bloqueado até este instante (inclusive). */
  lockoutEnd: Date | null;
  /** AspNetUsers.AccessFailedCount. */
  accessFailedCount: number;
}

/** IsLockedOutAsync: só com o bloqueio ativo, e até ao fim do bloqueio (inclusive). */
export function estaBloqueado(estado: EstadoBloqueio, agora: Date = new Date()): boolean {
  return estado.lockoutEnabled && estado.lockoutEnd !== null && estado.lockoutEnd.getTime() >= agora.getTime();
}

/**
 * AccessFailedAsync: conta mais uma falha; à 5.ª bloqueia 15 min e volta a contar do zero.
 * Conta mesmo com lockoutEnabled false (como o .NET) — só o estaBloqueado o ignora.
 */
export function registarFalha(estado: EstadoBloqueio, agora: Date = new Date()): EstadoBloqueio {
  const falhas = estado.accessFailedCount + 1;
  if (falhas < MAX_TENTATIVAS_FALHADAS) return { ...estado, accessFailedCount: falhas };
  return { ...estado, lockoutEnd: new Date(agora.getTime() + DURACAO_BLOQUEIO_MS), accessFailedCount: 0 };
}

/** ResetAccessFailedCountAsync: depois de um login certo. Não mexe no fim do bloqueio. */
export function limparFalhas(estado: EstadoBloqueio): EstadoBloqueio {
  return estado.accessFailedCount === 0 ? estado : { ...estado, accessFailedCount: 0 };
}
