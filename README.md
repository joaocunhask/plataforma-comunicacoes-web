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
1. **ETL** SQL Server → Postgres com checksums por tabela (`scripts/etl/`) — ✅ feito e
   verificado contra a BD de dev do .NET; falta correr contra uma **cópia** da BD de produção
2. **Motor de cálculo** em `src/lib/calculo/`, a reproduzir ao cêntimo o motor C# — ✅ feito
3. **Login** com os hashes ASP.NET Identity e o 2FA migrados, sem reset de passwords —
   ✅ feito (`src/lib/identity/` + Better Auth em `src/lib/auth/`), verificado de ponta a ponta

## Autenticação (`src/lib/auth/`)

Better Auth com sessões em BD, e o fluxo de login da API .NET num plugin próprio
(`plugin-identity.ts`):

1. conta bloqueada → recusa antes de ver a password (`CONTA_BLOQUEADA`)
2. password no formato do Identity; errada → conta uma falha (5 → 15 min bloqueado)
3. certa → limpa as falhas e regrava o hash se tiver parâmetros antigos (V2, SHA256, < 100 000)
4. conta por ativar → `EMAIL_NOT_VERIFIED`
5. 2FA ativo → desafio (cookie assinado, 10 min) e `/entrar/codigo`; o código valida-se
   com o TOTP do Identity (as chaves já configuradas continuam a valer)
6. empresa: nenhuma → `SEM_EMPRESA`; uma → fica ativa; várias → `/escolher-empresa`

Sessão: 30 min sem atividade (renovada por `RenovarSessao` enquanto se usa a página) e
teto absoluto de 12 h desde o login — os valores de produção da API .NET. As páginas leem
a sessão por `src/lib/auth/sessao.ts` (`exigirSessao`, `exigirEmpresaAtiva`).

**Modelo:** o utilizador do Better Auth é o próprio `AspNetUsers` (ids e chaves estrangeiras
intactos; o ETL continua 1:1). Tabelas novas: `auth_sessoes` (com `empresa_ativa_id`),
`auth_contas` (o hash da password vive aqui, em `password`) e `auth_verificacoes`. O email
tem de estar em minúsculas (o Better Auth procura assim): o ETL converte-o.

**Diferença deliberada face ao .NET:** o código 2FA só é aceite depois da password. A API
.NET aceita `/auth/totp/verify` com email + código, sem password — um atalho que deixa o
TOTP sozinho abrir a conta.

Variáveis: `BETTER_AUTH_SECRET` (aleatório, ≥ 32 bytes) e `BETTER_AUTH_URL` (o URL público).
Sem o segredo o build passa, mas o Better Auth recusa-se a arrancar em produção. Na Vercel
estão configuradas desde 2026-10-12: o segredo em Production e Preview (tipo Secret), o URL
só em Production (nos previews o Better Auth deduz o URL do pedido).

**Vercel:** o projeto (equipa INUBIA) está protegido por Vercel Authentication — só membros
da equipa chegam à app. Funções em `fra1`, junto à Neon.

## Compatibilidade com o Identity (`src/lib/identity/`)

Para os utilizadores entrarem depois do corte **com a password e o autenticador de sempre**:

| Módulo | O quê | Origem .NET |
|---|---|---|
| `password.ts` | verifica `AspNetUsers.PasswordHash` (V2 e V3, qualquer PRF/iterações); diz se precisa de rehash | `PasswordHasher.VerifyHashedPassword` |
| `totp.ts` | valida o código do autenticador (`AspNetUserTokens`/`AuthenticatorKey`), janela ±2 passos; gera chaves e o URI do QR | `AuthenticatorTokenProvider`, `Base32`, `Rfc6238AuthenticationService` |
| `bloqueio.ts` | 5 falhas → 15 min bloqueado (`LockoutEnd`, `AccessFailedCount`) | `UserManager` + opções da API |

Validado contra o **próprio pacote** `Microsoft.Extensions.Identity.Core` 10.0.8 (o de
produção) em `tests/oraculo/identity-net.json`, incluindo as arestas: base64 estrito,
hashes malformados, surrogates soltos, chave só com espaços, códigos com espaços/zeros.

### Riscos da migração encontrados
- **Tokens OAuth do Pipedrive** (`org_pipedrive_oauth_tokens`) estão cifrados com o Data
  Protection do ASP.NET (purpose `PipedriveOAuth.Tokens.v1`, key ring em ficheiros no VPS,
  `DataProtection:KeysPath`). Fora do .NET não se decifram: ou uma ferramenta .NET de uso
  único os decifra no VPS e volta a cifrar para o sistema novo, ou cada utilizador volta a
  ligar a app do Pipedrive depois do corte.
- **Links de convite e de reset de password** (Data Protection, 24 h) deixam de valer no
  corte: fazê-lo sem convites pendentes, ou reenviá-los.
- As chaves do autenticador estão em claro (`ProtectPersonalData` desligado), por isso
  migram tal e qual.

## ETL (`scripts/etl/`)

Copia o SQL Server para o Postgres **1:1** (mesmos nomes, mesmos ids), numa só transação:
lê a estrutura dos dois lados e recusa se não baterem (tabela ou coluna em falta, coluna
calculada só de um lado), copia pela ordem das chaves estrangeiras, volta a ler o que gravou
e compara com a origem tabela a tabela (contagem + SHA-256 das linhas na forma canónica).
Uma tabela que não bata → ROLLBACK, nada fica gravado.

- **Origem** (`MSSQL_CONNECTION_STRING`): uma cópia da BD de produção; o ETL só faz SELECT.
  Decimais, datas e uuids são convertidos para texto no próprio SQL Server
  (`canonico.ts`): o driver `mssql` passava-os por float e por `Date` com fuso.
- **Destino** (`DATABASE_URL`): com as migrações aplicadas e **vazio**. Se não for
  localhost, exige `--confirmar`.
- **Além da cópia:** `AspNetUsers.Email` passa a minúsculas; o `PasswordHash` passa para
  `auth_contas` (onde o login o lê) e fica NULL no `AspNetUsers`; as sequências identity
  avançam para o maior id.
- **Fica de fora:** `__EFMigrationsHistory` e as tabelas da branch `feat/catalogo-vigencias`
  do .NET (`ref_campanhas_vodafone`, `ref_produto_classe_vigencia`), que ainda não estão em
  produção. O relatório mostra quantas linhas têm.
- **Precisão:** `datetime2` tem 7 casas e o Postgres 6; o 7.º dígito (100 ns) arredonda-se.

```bash
npm run db:migrate
npm run etl -- --simular       # tudo, menos o COMMIT: só o relatório
npm run etl                    # destino local
npm run etl -- --confirmar     # destino remoto (Neon)
```

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
copiar, e grava os resultados (corre com ICU e cultura invariante, como a produção). O
teste `tests/oraculo` exige igualdade do texto em todos. O mesmo gerador produz
`identity-net.json` para a compatibilidade com o Identity.

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
cp .env.example .env.local   # preencher DATABASE_URL e BETTER_AUTH_SECRET
npm install
npm run dev
npm test
npm run db:status            # a que BD o .env.local aponta (só leitura)
```

Login em desenvolvimento (só numa BD de desenvolvimento; recusa correr se houver empresas reais):
```bash
npm run dev:utilizadores-teste      # cria 5 utilizadores @exemplo.test (password e chave 2FA no .env.local)
npm run dev:codigo-2fa              # o código atual do autenticador de teste
npm run dev:verificar-login         # verifica o fluxo de ponta a ponta contra o npm run dev
npm run dev:utilizadores-teste -- --apagar   # remove-os (o ETL exige a BD vazia)
```
