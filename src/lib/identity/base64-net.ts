// Convert.FromBase64String do .NET. O Buffer.from(…, "base64") do Node é permissivo
// (ignora caracteres inválidos e aceita falta de padding); o .NET lança FormatException.
// Como o PasswordHasher do Identity não apanha essa exceção, um hash malformado na BD
// fazia o login rebentar — e é isso que aqui se reproduz (Base64InvalidoError).

export class Base64InvalidoError extends Error {
  constructor() {
    super("O texto não é base64 válido (Convert.FromBase64String).");
    this.name = "Base64InvalidoError";
  }
}

// O .NET ignora espaço, \t, \r e \n em qualquer posição; o resto tem de ser o alfabeto
// base64 padrão, com comprimento múltiplo de 4 e no máximo dois '=' no fim.
const ESPACOS_BASE64 = /[ \t\r\n]/g;
const BASE64_ESTRITO = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function deBase64Net(texto: string): Buffer {
  const limpo = texto.replace(ESPACOS_BASE64, "");
  if (!BASE64_ESTRITO.test(limpo)) throw new Base64InvalidoError();
  return Buffer.from(limpo, "base64");
}
