# plataforma-comunicacoes-web

Reescrita da PlataformaComunicacoes (.NET/Blazor/SQL Server na Azure) em
**Next.js + TypeScript**, com deploy na **Vercel** e **Postgres na Neon** (UE).

> Fase atual: **prova de conceito**. O sistema .NET continua em produção e congelado
> (só correções) até ao corte.

## Stack
- Next.js (App Router) + TypeScript — uma só app; portal, admin e API por hostname/rota
- Postgres (Neon, Frankfurt) + Drizzle ORM — schema em `src/db/schema.ts`, migrações em `drizzle/`
- Dinheiro em `NetDecimal` (`src/lib/calculo/decimal-net.ts`), com a semântica do decimal do .NET
- Vitest — os cálculos têm de bater ao cêntimo com o sistema atual

## Prova de conceito (critérios de saída)
1. **ETL** SQL Server → Postgres com checksums por tabela (`scripts/etl/`) — por fazer
2. **Motor de cálculo** em `src/lib/calculo/`, a reproduzir ao cêntimo o motor C# — ✅ feito
3. **Login** com os hashes ASP.NET Identity e o 2FA migrados, sem reset de passwords — por fazer

## Motor de cálculo (`src/lib/calculo/`)

Port fiel do motor C#, em funções **puras** (sem BD nem Pipedrive): quem chama lê os
dados, chama o motor e grava o resultado. Cada ficheiro diz de que classe C# vem.

| Módulo | O quê | Origem C# |
|---|---|---|
| `upfront.ts` | upfront de uma linha | `UpfrontCalculator` |
| `premio-trimestral.ts` | prémio trimestral de uma linha | `TrimestralPremiosCalculator` |
| `apuramento-upfront.ts` | linhas por subscrição, data de início preservada, acerto RECALCULO | `UpfrontApuramentoService` |
| `apuramento-trimestral.ts` | linhas do trimestre, realizado por funil, patamar, margens | `TrimestralApuramentoService` |
| `patamares.ts` | períodos, degraus (cliff), margens por período, fecho | `Shared/Patamares`, `PatamaresService`, `PatamaresFechoService` |
| `acertos.ts` | rácio comercial/bruto, comercial derivado, agregado do painel | `AcertosService` |
| `observacoes.ts` | subscrições escritas pela app nas observações do produto | `DealProductCommentsParser.Parse` |
| `decimal-net.ts`, `texto-net.ts` | decimal, Trim, int.TryParse com as regras do .NET | `System.Decimal`, `string`, `int` |

**Porquê um decimal próprio:** o decimal do .NET tem mantissa de 96 bits e no máximo 28
casas, e arredonda ao par quando um resultado não cabe (ex.: o rácio `liquido / bruto`
dos acertos). O `NetDecimal` reproduz essas regras e também a escala dos resultados, ou
seja, o texto que se grava (`600.00`, não `600`). Nunca usar `number` para dinheiro.

**Ordem:** onde o C# fazia `FirstOrDefault` numa consulta sem `ORDER BY`, o motor usa o
primeiro da lista. Quem consulta a BD deve ordenar (por id).

### Oráculo: o motor TS contra o motor C#

`tests/oraculo/casos-net.json` tem ~11 500 casos calculados pelo **próprio código C#**
(aritmética do decimal, upfront, prémio, patamares, acertos, observações, texto). A
ferramenta `ferramentas/oraculo-net` compila os ficheiros originais do repo .NET, sem os
copiar, e grava os resultados. O teste `tests/oraculo` exige igualdade do texto em todos.

```bash
npm run oraculo:gerar   # só quando o motor C# mudar; precisa do .NET 10 e do repo .NET ao lado
```

Os testes em `tests/calculo` são o port dos testes C# do motor e dos cenários do webhook e do
apuramento trimestral, mais o replay do apuramento real de 2026-Q3 (bate ao cêntimo).

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
npm run db:status            # a que BD o .env.local aponta (só leitura)
```
