// O código atual da aplicação autenticadora do utilizador de teste (DEV_TESTE_CHAVE_2FA).
//   npm run dev:codigo-2fa
import { calcularTotp, deBase32Identity } from "../../src/lib/identity/totp";

const chave = process.env.DEV_TESTE_CHAVE_2FA;
if (!chave) throw new Error("Falta DEV_TESTE_CHAVE_2FA no .env.local (correr npm run dev:utilizadores-teste).");
const passo = BigInt(Math.floor(Date.now() / 1000 / 30));
console.log(String(calcularTotp(deBase32Identity(chave), passo)).padStart(6, "0"));
