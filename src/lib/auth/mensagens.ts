// Mensagens para o utilizador a partir dos erros do Better Auth e do plugin compat-identity.

const MENSAGENS: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "Email ou password incorretos.",
  INVALID_EMAIL: "Email inválido.",
  EMAIL_NOT_VERIFIED: "A conta ainda não foi ativada. Use o link do convite que recebeu por email.",
};

export function mensagemDeErro(erro: { code?: string; message?: string; status?: number }): string {
  if (erro.status === 429) return "Demasiadas tentativas. Aguarde um pouco e tente de novo.";
  return (erro.code && MENSAGENS[erro.code]) || erro.message || "Não foi possível entrar. Tente de novo.";
}
