// Compatibilidade com o ASP.NET Core Identity da plataforma .NET: as passwords, o 2FA e o
// bloqueio de conta dos utilizadores existentes continuam a funcionar depois da migração.
// Só servidor (usa node:crypto).

export * from "./base64-net";
export * from "./bloqueio";
export * from "./password";
export * from "./totp";
