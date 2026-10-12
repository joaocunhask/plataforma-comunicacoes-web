// Verificação das passwords guardadas pelo ASP.NET Core Identity (AspNetUsers.PasswordHash),
// para os utilizadores entrarem com a password de sempre depois da migração.
// Port fiel de PasswordHasher<TUser>.VerifyHashedPassword (Microsoft.Extensions.Identity.Core
// 10.0.8, a versão em produção), validado contra o próprio pacote em tests/oraculo.
//
// Formatos (base64 de):
//   V2: 0x00 | salt(16) | subchave(32)                       — PBKDF2-HMAC-SHA1, 1000 iterações
//   V3: 0x01 | prf(4, BE) | iterações(4, BE) | tamanho do salt(4, BE) | salt | subchave
//       prf 0 = HMAC-SHA1, 1 = HMAC-SHA256, 2 = HMAC-SHA512; o .NET atual gera SHA512, 100 000.

import { pbkdf2, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { deBase64Net } from "./base64-net";

const pbkdf2Async = promisify(pbkdf2);

/**
 * PasswordVerificationResult do .NET. "ok-rehash" = a password está certa mas o hash usa
 * parâmetros antigos (V2, SHA1/SHA256, ou menos iterações do que as atuais); o Identity
 * regrava-o nesse momento com os parâmetros atuais.
 */
export type ResultadoPassword = "falhou" | "ok" | "ok-rehash";

/** Iterações do PasswordHasher por omissão no .NET 7+ (a referência para o "ok-rehash"). */
export const ITERACOES_IDENTITY = 100_000;

const PRF_PBKDF2: Record<number, string> = { 0: "sha1", 1: "sha256", 2: "sha512" };
const SHA512 = 2;
const INT32_MAX = 2 ** 31 - 1;

/**
 * O EncoderFallbackException do .NET: o KeyDerivation.Pbkdf2 codifica a password em UTF-8
 * ESTRITO e lança com um surrogate solto (o Buffer do Node trocá-lo-ia por U+FFFD em
 * silêncio — e aceitaria a password de quem tem U+FFFD no lugar).
 */
export class PasswordUtf16InvalidaError extends Error {
  constructor() {
    super("A password tem um surrogate UTF-16 solto (não é codificável em UTF-8).");
    this.name = "PasswordUtf16InvalidaError";
  }
}

async function subchave(password: string, salt: Buffer, digest: string, iteracoes: number, tamanho: number) {
  if (!password.isWellFormed()) throw new PasswordUtf16InvalidaError();
  return pbkdf2Async(Buffer.from(password, "utf8"), salt, iteracoes, tamanho, digest);
}

function iguais(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

async function verificarV2(hash: Buffer, password: string): Promise<boolean> {
  if (hash.length !== 1 + 16 + 32) return false;
  const esperada = hash.subarray(17);
  return iguais(await subchave(password, hash.subarray(1, 17), "sha1", 1000, 32), esperada);
}

async function verificarV3(hash: Buffer, password: string): Promise<{ ok: boolean; iteracoes: number; prf: number }> {
  const falhou = { ok: false, iteracoes: 0, prf: 0 };
  if (hash.length < 13) return falhou; // o .NET lê o cabeçalho e sai do array → catch → false
  const prf = hash.readUInt32BE(1);
  const iteracoes = hash.readInt32BE(5);
  const tamanhoSalt = hash.readInt32BE(9);
  if (tamanhoSalt < 16) return falhou;
  if (13 + tamanhoSalt > hash.length) return falhou;
  const tamanhoSubchave = hash.length - 13 - tamanhoSalt;
  if (tamanhoSubchave < 16) return falhou;

  // Parâmetros que fazem o KeyDerivation.Pbkdf2 lançar: o .NET apanha e devolve false.
  const digest = PRF_PBKDF2[prf];
  if (digest === undefined || iteracoes <= 0 || iteracoes > INT32_MAX) return falhou;

  const salt = hash.subarray(13, 13 + tamanhoSalt);
  const esperada = hash.subarray(13 + tamanhoSalt);
  // No V3 o .NET corre a derivação dentro de um try: um surrogate solto dá só "falhou".
  if (!password.isWellFormed()) return falhou;
  const ok = iguais(await subchave(password, salt, digest, iteracoes, tamanhoSubchave), esperada);
  return { ok, iteracoes, prf };
}

/**
 * PasswordHasher.VerifyHashedPassword com as opções por omissão (V3, 100 000 iterações).
 * Lança como o .NET: Base64InvalidoError se o hash não for base64 válido, e
 * PasswordUtf16InvalidaError num hash V2 com uma password com um surrogate solto.
 * Um hash null (utilizador sem password) dá "falhou", como o UserManager.CheckPasswordAsync.
 */
export async function verificarPasswordIdentity(hashGuardado: string | null, password: string): Promise<ResultadoPassword> {
  if (hashGuardado === null) return "falhou";
  const hash = deBase64Net(hashGuardado);
  if (hash.length === 0) return "falhou";

  switch (hash[0]) {
    case 0x00:
      return (await verificarV2(hash, password)) ? "ok-rehash" : "falhou";
    case 0x01: {
      const r = await verificarV3(hash, password);
      if (!r.ok) return "falhou";
      return r.iteracoes < ITERACOES_IDENTITY || r.prf !== SHA512 ? "ok-rehash" : "ok";
    }
    default:
      return "falhou"; // marcador desconhecido
  }
}
