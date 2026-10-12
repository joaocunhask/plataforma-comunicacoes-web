// Compatibilidade com o ASP.NET Core Identity: comportamento documentado em exemplos.
// A fidelidade caso a caso ao pacote .NET está em tests/oraculo/identity-net.test.ts.
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  calcularTotp,
  deBase32Identity,
  DURACAO_BLOQUEIO_MS,
  type EstadoBloqueio,
  estaBloqueado,
  gerarChaveAutenticador,
  hashPasswordIdentity,
  limparFalhas,
  precisaDeRehash,
  registarFalha,
  uriOtpauth,
  validarCodigoAutenticador,
  verificarPasswordIdentity,
} from "@/lib/identity";

/** Um hash V3 no formato do Identity (o que está em AspNetUsers.PasswordHash). */
function hashV3(password: string, prf: 1 | 2, iteracoes: number): string {
  const salt = randomBytes(16);
  const subchave = pbkdf2Sync(password, salt, iteracoes, 32, prf === 2 ? "sha512" : "sha256");
  const cabecalho = Buffer.alloc(13);
  cabecalho[0] = 0x01;
  cabecalho.writeUInt32BE(prf, 1);
  cabecalho.writeUInt32BE(iteracoes, 5);
  cabecalho.writeUInt32BE(salt.length, 9);
  return Buffer.concat([cabecalho, salt, subchave]).toString("base64");
}

describe("verificarPasswordIdentity", () => {
  it("hash atual (V3, SHA512, 100 000 iterações): ok com a password certa, falhou com outra", async () => {
    const hash = hashV3("Password1!", 2, 100_000);
    expect(await verificarPasswordIdentity(hash, "Password1!")).toBe("ok");
    expect(await verificarPasswordIdentity(hash, "password1!")).toBe("falhou");
  });

  it("parâmetros antigos (SHA256 ou menos iterações) dão ok-rehash", async () => {
    expect(await verificarPasswordIdentity(hashV3("abc", 1, 10_000), "abc")).toBe("ok-rehash");
    expect(await verificarPasswordIdentity(hashV3("abc", 2, 10_000), "abc")).toBe("ok-rehash");
  });

  it("utilizador sem password, hash vazio ou marcador desconhecido: falhou", async () => {
    expect(await verificarPasswordIdentity(null, "x")).toBe("falhou");
    expect(await verificarPasswordIdentity("", "x")).toBe("falhou");
    expect(await verificarPasswordIdentity("AgAA", "x")).toBe("falhou");
  });

  it("hash que não é base64 lança, como o Convert.FromBase64String do .NET", async () => {
    await expect(verificarPasswordIdentity("!!!!", "x")).rejects.toThrow(/base64/);
  });
});

describe("hashPasswordIdentity", () => {
  it("gera o formato atual do Identity (V3, SHA512, 100 000 iterações), que verifica como 'ok'", async () => {
    const hash = await hashPasswordIdentity("Password1!");
    expect(Buffer.from(hash, "base64").subarray(0, 13).toString("hex")).toBe("0100000002000186a000000010");
    expect(await verificarPasswordIdentity(hash, "Password1!")).toBe("ok");
    expect(precisaDeRehash(hash)).toBe(false);
  });

  it("precisaDeRehash segue o critério do ok-rehash, só pelo cabeçalho", () => {
    expect(precisaDeRehash(hashV3("x", 1, 100_000))).toBe(true); // SHA256
    expect(precisaDeRehash(hashV3("x", 2, 10_000))).toBe(true); // poucas iterações
    expect(precisaDeRehash(Buffer.concat([Buffer.from([0]), randomBytes(48)]).toString("base64"))).toBe(true); // V2
  });
});

describe("TOTP", () => {
  // RFC 6238, apêndice B (SHA1), truncado a 6 dígitos como o Identity.
  const segredoRfc = Buffer.from("12345678901234567890", "ascii");
  it.each([
    [59, 287082],
    [1111111109, 81804],
    [1111111111, 50471],
    [1234567890, 5924],
    [2000000000, 279037],
    [20000000000, 353130],
  ])("vetor do RFC 6238: t=%i → %i", (segundos, codigo) => {
    expect(calcularTotp(segredoRfc, BigInt(Math.floor(segundos / 30)))).toBe(codigo);
  });

  const chave = gerarChaveAutenticador();
  const agora = 1_791_800_000;
  const codigoDoPasso = (desvio: number) =>
    String(calcularTotp(deBase32Identity(chave), BigInt(Math.floor(agora / 30) + desvio))).padStart(6, "0");

  it("aceita o código de até 2 passos (60 s) para cada lado, não 3", () => {
    for (const desvio of [-2, -1, 0, 1, 2]) expect(validarCodigoAutenticador(chave, codigoDoPasso(desvio), agora)).toBe(true);
    for (const desvio of [-3, 3]) {
      // Um código de ±3 passos pode coincidir por acaso com um da janela; só conta se não coincidir.
      const coincide = [-2, -1, 0, 1, 2].some((d) => codigoDoPasso(d) === codigoDoPasso(desvio));
      if (!coincide) expect(validarCodigoAutenticador(chave, codigoDoPasso(desvio), agora)).toBe(false);
    }
  });

  it("lê o código como o int.TryParse: espaços à volta e zeros à esquerda passam; letras não", () => {
    const codigo = codigoDoPasso(0);
    expect(validarCodigoAutenticador(chave, ` ${codigo} `, agora)).toBe(true);
    expect(validarCodigoAutenticador(chave, `0${codigo}`, agora)).toBe(true);
    expect(validarCodigoAutenticador(chave, "abc123", agora)).toBe(false);
    expect(validarCodigoAutenticador(chave, null, agora)).toBe(false);
  });

  it("sem chave (2FA nunca configurado) recusa", () => {
    expect(validarCodigoAutenticador(null, "123456", agora)).toBe(false);
    expect(validarCodigoAutenticador("", "123456", agora)).toBe(false);
  });

  it("gera chaves como o Identity: 32 caracteres base32 → 20 bytes", () => {
    expect(chave).toMatch(/^[A-Z2-7]{32}$/);
    expect(deBase32Identity(chave)).toHaveLength(20);
    expect(deBase32Identity(chave.toLowerCase())).toEqual(deBase32Identity(chave));
  });

  it("o URI do QR code é o mesmo que a API .NET devolve", () => {
    expect(uriOtpauth("ana@exemplo.pt", "ABC")).toBe(
      "otpauth://totp/PlataformaComunicacoes:ana@exemplo.pt?secret=ABC&issuer=PlataformaComunicacoes",
    );
  });
});

describe("bloqueio de conta (5 falhas → 15 min)", () => {
  const inicio: EstadoBloqueio = { lockoutEnabled: true, lockoutEnd: null, accessFailedCount: 0 };
  const agora = new Date("2026-10-12T10:00:00Z");

  it("à 5.ª falha bloqueia 15 minutos e volta a contar do zero", () => {
    let estado = inicio;
    for (let i = 0; i < 4; i++) estado = registarFalha(estado, agora);
    expect(estado.accessFailedCount).toBe(4);
    expect(estaBloqueado(estado, agora)).toBe(false);

    estado = registarFalha(estado, agora);
    expect(estado.accessFailedCount).toBe(0);
    expect(estado.lockoutEnd?.getTime()).toBe(agora.getTime() + DURACAO_BLOQUEIO_MS);
    expect(estaBloqueado(estado, agora)).toBe(true);
    expect(estaBloqueado(estado, new Date(agora.getTime() + DURACAO_BLOQUEIO_MS))).toBe(true); // inclusive
    expect(estaBloqueado(estado, new Date(agora.getTime() + DURACAO_BLOQUEIO_MS + 1))).toBe(false);
  });

  it("com o bloqueio desligado conta as falhas mas nunca bloqueia", () => {
    let estado: EstadoBloqueio = { ...inicio, lockoutEnabled: false };
    for (let i = 0; i < 5; i++) estado = registarFalha(estado, agora);
    expect(estado.lockoutEnd).not.toBeNull();
    expect(estaBloqueado(estado, agora)).toBe(false);
  });

  it("um login certo limpa as falhas, mas não o fim de um bloqueio", () => {
    const estado = limparFalhas({ ...inicio, accessFailedCount: 3, lockoutEnd: agora });
    expect(estado).toEqual({ ...inicio, accessFailedCount: 0, lockoutEnd: agora });
  });
});
