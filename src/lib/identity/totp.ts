// 2FA por aplicação autenticadora (TOTP), compatível com o ASP.NET Core Identity, para as
// chaves já configuradas (AspNetUserTokens: [AspNetUserStore] / AuthenticatorKey)
// continuarem a funcionar sem os utilizadores voltarem a ler o QR code.
//
// Port fiel de AuthenticatorTokenProvider.ValidateAsync, Base32 e
// Rfc6238AuthenticationService.ComputeTotp (Microsoft.Extensions.Identity.Core 10.0.8),
// validado contra o próprio pacote em tests/oraculo.

import { createHmac, randomBytes } from "node:crypto";
import { maiusculaInvariantNet, tryParseIntNet, vazioNet } from "@/lib/calculo/texto-net";

const ALFABETO_BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PASSO_SEGUNDOS = 30;
/** O Identity aceita códigos de até 2 passos (60 s) para cada lado — "90s", diz o comentário do .NET. */
const JANELA_PASSOS = 2;

/** O FormatException do Base32.FromBase32 (um carácter fora do alfabeto). */
export class ChaveBase32InvalidaError extends Error {
  constructor() {
    super("Chave do autenticador com caracteres fora do alfabeto base32.");
    this.name = "ChaveBase32InvalidaError";
  }
}

/** Base32.FromBase32 do Identity: ignora '=' no fim e maiúsculas/minúsculas. */
export function deBase32Identity(texto: string): Buffer {
  let fim = texto.length;
  while (fim > 0 && texto[fim - 1] === "=") fim--;
  const saida = Buffer.alloc(Math.floor((fim * 5) / 8));

  let bitIndex = 0;
  let inputIndex = 0;
  let outputBits = 0;
  let outputIndex = 0;
  while (outputIndex < saida.length) {
    const valor = ALFABETO_BASE32.indexOf(maiusculaInvariantNet(texto[inputIndex]));
    if (valor < 0) throw new ChaveBase32InvalidaError();

    const bits = Math.min(5 - bitIndex, 8 - outputBits);
    saida[outputIndex] = (saida[outputIndex] << bits) | (valor >> (5 - (bitIndex + bits)));
    bitIndex += bits;
    if (bitIndex >= 5) {
      inputIndex++;
      bitIndex = 0;
    }
    outputBits += bits;
    if (outputBits >= 8) {
      outputIndex++;
      outputBits = 0;
    }
  }
  return saida;
}

/** Base32.ToBase32 do Identity: maiúsculas, blocos de 8 com '=' no último se incompleto. */
export function paraBase32Identity(bytes: Uint8Array): string {
  let texto = "";
  for (let offset = 0; offset < bytes.length; offset += 5) {
    const total = Math.min(5, bytes.length - offset);
    // 40 bits do bloco (completado com zeros) → 8 caracteres de 5 bits.
    let bits = 0n;
    for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(i < total ? bytes[offset + i] : 0);
    const caracteres = Math.ceil((total * 8) / 5);
    for (let i = 0; i < 8; i++) {
      texto += i < caracteres ? ALFABETO_BASE32[Number((bits >> BigInt(35 - i * 5)) & 31n)] : "=";
    }
  }
  return texto;
}

/** Rfc6238AuthenticationService.ComputeTotp: HOTP (RFC 4226) com HMAC-SHA1, 6 dígitos. */
export function calcularTotp(chave: Uint8Array, passo: bigint): number {
  const mensagem = Buffer.alloc(8);
  mensagem.writeBigUInt64BE(BigInt.asUintN(64, passo));
  const hash = createHmac("sha1", chave).update(mensagem).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const binario =
    ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
  return binario % 1_000_000;
}

/**
 * AuthenticatorTokenProvider.ValidateAsync: o código vale se for o de algum passo entre
 * −2 e +2 à volta de agora. O código é lido como o int.TryParse do .NET — aceita espaços à
 * volta, "+" e zeros à esquerda ("0123456" é 123456) — e comparado como número.
 * Chave null/vazia ou código não numérico → false. Uma chave com caracteres fora do base32
 * (incluindo uma chave só com espaços) lança, como no .NET.
 */
export function validarCodigoAutenticador(
  chave: string | null,
  codigo: string | null,
  agoraSegundosUnix: number = Math.floor(Date.now() / 1000),
): boolean {
  if (vazioNet(chave)) return false;
  const numero = tryParseIntNet(codigo);
  if (numero === null) return false;

  const chaveBytes = deBase32Identity(chave);
  const passo = BigInt(Math.floor(agoraSegundosUnix / PASSO_SEGUNDOS));
  for (let i = -JANELA_PASSOS; i <= JANELA_PASSOS; i++) {
    if (calcularTotp(chaveBytes, passo + BigInt(i)) === numero) return true;
  }
  return false;
}

/** UserManager.GenerateNewAuthenticatorKey: 20 bytes aleatórios em base32 (32 caracteres). */
export function gerarChaveAutenticador(): string {
  return paraBase32Identity(randomBytes(20));
}

/** O URI do QR code, no formato que a API .NET devolve em /auth/totp/setup. */
export function uriOtpauth(email: string, chave: string): string {
  return `otpauth://totp/PlataformaComunicacoes:${email}?secret=${chave}&issuer=PlataformaComunicacoes`;
}
