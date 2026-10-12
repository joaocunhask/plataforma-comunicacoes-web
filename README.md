# plataforma-comunicacoes-web

Reescrita da PlataformaComunicacoes (.NET/Blazor/SQL Server na Azure) em
**Next.js + TypeScript**, com deploy na **Vercel** e **Postgres na Neon** (UE).

> Fase atual: **prova de conceito**. O sistema .NET continua em produção e congelado
> (só correções) até ao corte.

## Stack
- Next.js (App Router) + TypeScript — uma só app; portal, admin e API por hostname/rota
- Postgres (Neon) + Drizzle ORM — schema em `src/db/schema.ts`, migrações em `drizzle/`
- decimal.js para todo o dinheiro
- Vitest — os cálculos têm de bater ao cêntimo com o sistema atual

## Prova de conceito (critérios de saída)
1. **ETL** SQL Server → Postgres com checksums por tabela (`scripts/etl/`)
2. **Motor de cálculo** (upfront + prémio trimestral) em `src/lib/calculo/`, a reproduzir
   ao cêntimo as linhas de produção
3. **Login** com os hashes ASP.NET Identity e o 2FA migrados, sem reset de passwords

## Regras herdadas (valem nesta stack)
- **Pipedrive:** zero DELETE; criar negócios só depois de verificar o `id_simulador`;
  agir só sobre alvos conhecidos; dry-run em operações em massa; estrear escritas na
  conta Sandbox (`Company - Sandbox`).
- **Multi-empresa:** toda a linha de tabela multi-empresa leva `empresa_id`.
- **Schema:** alterações pedem confirmação explícita; nada destrutivo em produção.

## Desenvolvimento
```bash
cp .env.example .env.local   # preencher DATABASE_URL
npm install
npm run dev
npm test
```
