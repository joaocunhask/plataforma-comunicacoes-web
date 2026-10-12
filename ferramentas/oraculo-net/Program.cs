// Oráculo do motor de cálculo e da compatibilidade com o Identity.
//
// Gera casos (aleatórios com semente fixa + arestas escolhidas à mão) e grava, para cada
// um, o resultado que o CÓDIGO C# DE PRODUÇÃO dá: as classes do motor são compiladas a
// partir do repo PlataformaComunicacoes (ver OraculoNet.csproj), não copiadas. Onde o C#
// tem a conta dentro de um serviço com BD (rácio dos acertos, líquido com patamar,
// int.TryParse, Trim), reproduz-se aqui a mesma expressão C#, que é o que se quer validar:
// a semântica do decimal, do arredondamento e do texto do .NET. O Identity (passwords e
// 2FA) vem do próprio pacote NuGet, na versão de produção (ver Identity.cs).
//
//   npm run oraculo:gerar     (= dotnet run --project ferramentas/oraculo-net -- tests/oraculo)
//
// Correr de novo só quando o motor C# mudar; o ficheiro gerado vai para o git e os
// testes TypeScript (tests/oraculo) comparam-se com ele sem precisar de .NET.

using System.Globalization;
using System.Text;
using System.Text.Json;
using PlataformaComunicacoes.Infrastructure.Services.Pipedrive;
using PlataformaComunicacoes.Infrastructure.Services.Vodafone;
using PlataformaComunicacoes.Shared.Patamares;

const int Semente = 20261012;
CultureInfo.DefaultThreadCurrentCulture = CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
var pasta = args.Length > 0 ? args[0] : "tests/oraculo";
var r = new Random(Semente);
var seccoes = new List<(string Nome, List<object?> Casos)>();

// ─── Geradores ────────────────────────────────────────────────────────────────

decimal Dec(long mantissaMax, int escala, bool podeNegativo = false)
{
    var m = r.NextInt64(0, mantissaMax + 1);
    var negativo = podeNegativo && r.Next(5) == 0;
    return new decimal((int)(m & 0xFFFFFFFF), (int)(m >> 32), 0, negativo, (byte)escala);
}

decimal DecGrande()
{
    var escala = r.Next(0, 29);
    return new decimal(r.Next(int.MinValue, int.MaxValue), r.Next(int.MinValue, int.MaxValue),
        r.Next(0, int.MaxValue), r.Next(2) == 0, (byte)escala);
}

decimal? Talvez(Func<decimal> gerar, int pctNull = 15) => r.Next(100) < pctNull ? null : gerar();

T Um<T>(params T[] opcoes) => opcoes[r.Next(opcoes.Length)];

DateOnly Data(DateOnly de, DateOnly ate) => de.AddDays(r.Next(0, ate.DayNumber - de.DayNumber + 1));

string S(decimal d) => d.ToString(CultureInfo.InvariantCulture);
string? SN(decimal? d) => d?.ToString(CultureInfo.InvariantCulture);
string D(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
string Tipo(TipoPeriodoPatamar t) => t.ToString().ToUpperInvariant();

void Seccao(string nome, List<object?> casos) => seccoes.Add((nome, casos));

// ─── Aritmética do decimal (o núcleo de tudo) ─────────────────────────────────

{
    var casos = new List<object?>();
    decimal Operando()
    {
        switch (r.Next(6))
        {
            case 0: return Dec(100_000_000_000, 2, true);            // dinheiro
            case 1: return Dec(200_000, 4, true);                     // taxas e ajustes
            case 2: return Dec(1_000, r.Next(0, 3), true);            // inteiros pequenos
            case 3:                                                   // rácios (28 casas)
            {
                var a = Dec(10_000_000, 2, true);
                var b = Dec(10_000_000, 2);
                return b == 0 ? a : a / b;
            }
            case 4: return DecGrande();
            default: return Dec(long.MaxValue / 2, r.Next(0, 29), true);
        }
    }

    void Caso(string op, decimal a, decimal b)
    {
        string resultado;
        try
        {
            resultado = op switch
            {
                "div" => S(a / b),
                "mul" => S(a * b),
                "add" => S(a + b),
                "sub" => S(a - b),
                "round2afz" => S(Math.Round(a, 2, MidpointRounding.AwayFromZero)),
                "round2even" => S(Math.Round(a, 2, MidpointRounding.ToEven)),
                "round0afz" => S(Math.Round(a, 0, MidpointRounding.AwayFromZero)),
                "min" => S(Math.Min(a, b)),
                "cmp" => a.CompareTo(b).ToString(CultureInfo.InvariantCulture),
                _ => throw new InvalidOperationException(op),
            };
        }
        catch (OverflowException) { resultado = "overflow"; }
        casos.Add(new { op, a = S(a), b = S(b), r = resultado });
    }

    string[] ops = ["div", "mul", "add", "sub", "round2afz", "round2even", "round0afz", "min", "cmp"];
    for (var i = 0; i < 3000; i++)
    {
        var op = Um(ops);
        var a = Operando();
        var b = Operando();
        if (op == "div" && b == 0) b = 7m;
        Caso(op, a, b);
    }

    // Empates exatos (o .NET arredonda AO PAR quando o resultado não cabe em 28 casas):
    // 2^-k tem k casas decimais e acaba em 5.
    foreach (var a in new[] { 1m, 3m, 7m, -1m, 5m, 1.5m })
        for (var k = 28; k <= 45; k++)
            Caso("div", a, (decimal)Math.Pow(2, k));
    foreach (var b in new[] { 0.00000000000001m, 0.00000000000003m, 0.00000000000005m, 0.00000000000007m })
        Caso("mul", 0.000000000000005m, b);
    foreach (var a in new[] { 0.125m, 0.135m, -0.125m, -0.135m, 2.5m, 3.5m, -2.5m, 0.005m, 0.015m, 23.52195m, 1.00500m })
    {
        Caso("round2afz", a, 0m);
        Caso("round2even", a, 0m);
        Caso("round0afz", a, 0m);
    }
    // Escala dos resultados (o texto que se grava): zeros e divisões exatas vs inexatas.
    decimal[] zeros = [0m, 0.00m, -0.00m, 0.0000000000000000000000000000m];
    decimal[] outros = [1.5m, 3.0809366464977919762326388757m, 0.01m, -2m, 0m, 0.000m];
    foreach (var z in zeros)
        foreach (var o in outros)
        {
            Caso("mul", z, o);
            Caso("mul", o, z);
            Caso("add", z, o);
            Caso("sub", z, o);
            Caso("round2afz", z * o, 0m);
            if (o != 0m) Caso("div", z, o);
        }
    // Zero vezes mantissas de 32, 64 e 96 bits, com várias escalas (o .NET tem um caminho
    // de código por tamanho de operando, e a escala de um produto nulo depende disso).
    foreach (var z in new[] { 0m, 0.0m, 0.00m, 0.000000000000000000000000000m, 0.0000000000000000000000000000m })
        foreach (var mantissa in new[] { 7L, 4_294_967_295L, 4_294_967_296L, 1_234_567_890_123L, long.MaxValue })
            foreach (var escala in new byte[] { 0, 2, 26, 27, 28 })
            {
                var o = new decimal((int)(mantissa & 0xFFFFFFFF), (int)(mantissa >> 32), 0, false, escala);
                Caso("mul", z, o);
                Caso("mul", o, z);
            }
    // Fronteira 28+19 = 47 casas no caminho de 32 bits, com produtos nulos e não nulos,
    // e produtos não nulos que arredondam para zero no caminho largo.
    foreach (var (ea, eb) in new (byte, byte)[] { (20, 27), (21, 27), (20, 28), (19, 28), (24, 24), (23, 24) })
        foreach (var (ma, mb) in new[] { (7L, 7L), (0L, 7L), (4_294_967_295L, 4_294_967_295L) })
            Caso("mul", new decimal((int)ma, (int)(ma >> 32), 0, false, ea), new decimal((int)mb, (int)(mb >> 32), 0, false, eb));
    foreach (var (ma, mb) in new[] { (1L, 1L << 40), (5L, 1L << 40), (3L, 1L << 40), (1L << 40, 1L << 40) })
        foreach (var e in new byte[] { 20, 28 })
            Caso("mul", new decimal((int)(ma & 0xFFFFFFFF), (int)(ma >> 32), 0, false, e), new decimal((int)(mb & 0xFFFFFFFF), (int)(mb >> 32), 0, false, e));
    foreach (var escala in new byte[] { 0, 2, 27, 28 })
    {
        var grande = new decimal(-1, -1, 1, false, escala);   // mantissa > 2^64
        foreach (var z in new[] { 0m, 0.00m, 0.0000000000000000000000000000m })
        {
            Caso("mul", z, grande);
            Caso("mul", grande, z);
        }
    }
    foreach (var (a, b) in new[]
             {
                 (2.00m, 0.6666666666666666666666666667m), (1.00m, 8m), (1.000m, 4m), (10.0m, 4m), (7.00m, 7m),
                 (1m, 0.3333333333333333333333333333m), (100.00m, 0.5m), (0.30m, 0.1m), (5.5m, 0.11m), (1m, 1.25m),
                 (12.3400m, 2m), (12.3400m, 3m), (99999999999999999999999999.99m, 9m), (2m, 3m), (20m, 3m),
             })
        Caso("div", a, b);
    Caso("div", 600.00m, 100m);
    Caso("div", 6m, 0.01m);
    Caso("div", 1m, 3m);
    Caso("div", 100m, 3m);
    Caso("div", 79228162514264337593543950335m, 0.1m);
    Caso("mul", 79228162514264337593543950335m, 2m);
    Caso("add", 79228162514264337593543950335m, 1m);
    Caso("add", 79228162514264337593543950335m, 0.5m);
    Caso("add", 79228162514264337593543950334m, 0.5m);
    Seccao("aritmetica", casos);
}

// ─── UpfrontCalculator ────────────────────────────────────────────────────────

{
    var casos = new List<object?>();
    void Caso(decimal valorUnidade, int quantidade, decimal upfront, decimal ajuste, decimal? margem)
    {
        var res = UpfrontCalculator.Calcular(new UpfrontLinhaInput(valorUnidade, quantidade, upfront, ajuste, margem));
        casos.Add(new
        {
            valorUnidade = S(valorUnidade), quantidade, upfrontPlano = S(upfront), ajusteDuracao = S(ajuste),
            margemUpfrontPct = SN(margem), bruto = S(res.ValorBruto), liquido = S(res.ValorLiquido),
        });
    }

    for (var i = 0; i < 1500; i++)
    {
        Caso(
            Dec(50_000, 2),
            r.Next(4) == 0 ? r.Next(1, 61) : 1,
            Dec(120_000, 4),
            Dec(25_000, 4),
            Talvez(() => Um(Dec(10_000, 2), Dec(100, 0), 50m, 0m, 100m)));
    }
    Caso(100m, 1, 6.0m, 1.0m, 50m);          // oráculo do negócio 6 (n8n): 600 / 300
    Caso(18.78m, 1, 1.0m, 1.2525m, 0m);      // 23.52195 → 23.52
    Caso(0.01m, 1, 0.5m, 1m, 33.33m);
    Caso(12.345m, 3, 1m, 1m, null);
    Seccao("upfront", casos);
}

// ─── TrimestralPremiosCalculator ──────────────────────────────────────────────

{
    var faixasPadrao = new List<AjustePropriaLinhaInput>
    {
        new(0.7000m, 0.7500m, 0.4000m), new(0.7500m, 0.8000m, 0.5000m), new(0.8000m, 0.8500m, 0.6000m),
        new(0.8500m, 0.9000m, 0.7000m), new(0.9000m, 0.9500m, 0.7500m), new(0.9500m, 1.0000m, 0.8000m),
        new(1.0000m, 9.9999m, 1.0000m),
    };
    var casos = new List<object?>();
    for (var i = 0; i < 1500; i++)
    {
        var objetivos = Enumerable.Range(1, r.Next(1, 6)).Select(id =>
        {
            var pct = r.Next(4) == 0 ? Dec(9_000, 4) : Dec(16_000, 4);
            var pos = r.Next(3) == 0 ? 1m : r.Next(2) == 0 ? Dec(10_000, 4) : Dec(12_000, 4);
            var atingido = r.Next(10) == 0 ? r.Next(2) == 0 : pct >= 0.90m;
            return new ObjetivoTrimestralInput(id, r.Next(6) == 0 ? r.Next(1, 6) : id, pos, pct, atingido);
        }).ToList();

        var faixas = r.Next(3) == 0 ? faixasPadrao.Where(_ => r.Next(3) != 0).ToList() : faixasPadrao;
        var plano = Enumerable.Range(0, r.Next(0, 7))
            .Select(_ => new PlanoComissionalInput(r.Next(1, 3), r.Next(1, 5), Dec(120_000, 4)))
            .ToList();
        var ctx = new ApuramentoContexto(objetivos, plano, faixas, Um(1m, 0.9m, 0.8m, Dec(10_000, 4)));

        var linha = new LinhaProdutoInput(
            Guid.NewGuid(), Guid.NewGuid(),
            IdFunilPipedrive: r.Next(1, 7),
            IdTipoReceita: r.Next(1, 3),
            Oferta: r.Next(1, 6),
            ValorUnidade: Dec(50_000, 2),
            Quantidade: r.Next(4) == 0 ? r.Next(0, 40) : 1,
            UpfrontLinha: Dec(120_000, 4),
            AjusteDuracao: Talvez(() => Dec(25_000, 4), 20),
            MargemPremioPct: Talvez(() => Dec(10_000, 2)));

        var res = TrimestralPremiosCalculator.Calcular(linha, ctx);
        casos.Add(new
        {
            // Em arrays para o ficheiro não crescer: [id, funil, posicionamento, pct, atingido],
            // [tipoReceita, oferta, ponderador], [pctMin, pctMax, ajuste].
            objetivos = objetivos.Select(o => new object[]
                { o.IdObjetivo, o.IdFunilPipedrive, S(o.Posicionamento), S(o.PctAtingimento), o.Atingido }),
            plano = plano.Select(p => new object[] { p.TipoReceita, p.Oferta, S(p.PonderadorPremio) }),
            faixas = faixas.Select(f => new[] { S(f.PctMin), S(f.PctMax), S(f.Ajuste) }),
            ajusteCruzado = S(ctx.AjusteCruzado),
            linha = new
            {
                idFunilPipedrive = linha.IdFunilPipedrive, idTipoReceita = linha.IdTipoReceita, oferta = linha.Oferta,
                valorUnidade = S(linha.ValorUnidade), quantidade = linha.Quantidade, upfrontLinha = S(linha.UpfrontLinha),
                ajusteDuracao = SN(linha.AjusteDuracao), margemPremioPct = SN(linha.MargemPremioPct),
            },
            objetivosAtingidos = TrimestralPremiosCalculator.ObjetivosAtingidos(objetivos),
            bruto = SN(res.PremioBruto),
            liquido = SN(res.PremioLiquido),
            erro = res.Erro?.ToString(),
        });
    }
    Seccao("premio", casos);
}

// ─── Patamares ────────────────────────────────────────────────────────────────

PatamarEscalao[] Escada()
{
    var n = r.Next(0, 5);
    decimal[] limites = [0m, 500m, 1000m, 1500m, 2000m];
    return Enumerable.Range(0, n).Select(_ => new PatamarEscalao(
        r.Next(1, 5),
        r.Next(3) == 0 ? Dec(300_000, 2) : Um(limites),
        Dec(10_000, 2))).ToArray();
}

object EscadaJson(IEnumerable<PatamarEscalao> escada) => escada.Select(e => new
{
    ordem = e.Ordem, limiteInferior = S(e.LimiteInferior), percentagemComercial = S(e.PercentagemComercial),
});

TipoPeriodoPatamar TipoAleatorio() => Um(TipoPeriodoPatamar.Mensal, TipoPeriodoPatamar.Trimestral, TipoPeriodoPatamar.Anual);

{
    var casos = new List<object?>();
    for (var i = 0; i < 800; i++)
    {
        var escada = Escada();
        var acumulado = r.Next(4) == 0 ? Um(0m, 500m, 999.99m, 1000m, 1500m, 2000m) : Dec(300_000, 2);
        var e = PatamarResolver.Resolver(escada, acumulado);
        casos.Add(new
        {
            escada = EscadaJson(escada), acumulado = S(acumulado),
            ordem = e?.Ordem, limiteInferior = SN(e?.LimiteInferior), percentagemComercial = SN(e?.PercentagemComercial),
        });
    }
    Seccao("patamarResolver", casos);
}

{
    var casos = new List<object?>();
    for (var i = 0; i < 600; i++)
    {
        var data = Data(new DateOnly(1999, 1, 1), new DateOnly(2031, 12, 31));
        var tipo = TipoAleatorio();
        var p = PatamarResolver.Balde(data, tipo);
        casos.Add(new { data = D(data), tipo = Tipo(tipo), inicio = D(p.Inicio), fim = D(p.Fim) });
    }
    Seccao("balde", casos);
}

{
    var casos = new List<object?>();
    foreach (var codigo in new[] { "MENSAL", "trimestral", "  Anual  ", "SEMANAL", "", "\u00A0mensal\u00A0", "\uFEFFMENSAL", "TRIMEﬆRAL", "anual\u0085" })
    {
        string? resultado;
        try { resultado = Tipo(PatamarResolver.ParseTipoPeriodo(codigo)); }
        catch (ArgumentException) { resultado = null; }
        casos.Add(new { codigo, tipo = resultado });
    }
    Seccao("parseTipoPeriodo", casos);
}

LinhaBrutoPeriodo[] Linhas(DateOnly de, DateOnly ate) => Enumerable.Range(0, r.Next(0, 9))
    .Select(_ => new LinhaBrutoPeriodo(Data(de, ate), Dec(150_000, 2)))
    .ToArray();

object LinhasJson(IEnumerable<LinhaBrutoPeriodo> linhas) => linhas.Select(l => new
{
    dataInicioContrato = D(l.DataInicioContrato), valorUpfrontBruto = S(l.ValorUpfrontBruto),
});

{
    var casos = new List<object?>();
    var de = new DateOnly(2025, 10, 1);
    var ate = new DateOnly(2026, 6, 30);
    for (var i = 0; i < 400; i++)
    {
        var tipo = TipoAleatorio();
        var linhas = Linhas(de, ate);
        var escada = Escada();
        var carimbos = linhas
            .Select(l => PatamarResolver.Balde(l.DataInicioContrato, tipo).Inicio)
            .Distinct()
            .Where(_ => r.Next(2) == 0)
            .ToDictionary(x => x, _ => Dec(10_000, 2));
        var hoje = Data(de, ate.AddMonths(2));
        var plano = PatamarMargemPlanner.Planear(linhas, tipo, escada, carimbos, hoje);
        var consultas = linhas.Select(l => l.DataInicioContrato).Append(Data(de, ate)).ToArray();
        casos.Add(new
        {
            tipo = Tipo(tipo), linhas = LinhasJson(linhas), escada = EscadaJson(escada),
            carimbos = carimbos.Select(kv => new { inicio = D(kv.Key), percentagem = S(kv.Value) }),
            hoje = D(hoje),
            porPeriodo = plano.PorPeriodo.Select(kv => new
            {
                inicio = D(kv.Key), fim = D(kv.Value.Periodo.Fim), acumulado = S(kv.Value.Acumulado),
                margem = SN(kv.Value.Margem), fechado = kv.Value.Fechado,
            }),
            margens = consultas.Select(d => new { data = D(d), margem = SN(plano.MargemPara(d)) }),
        });
    }
    Seccao("margemPlanner", casos);
}

{
    var casos = new List<object?>();
    var de = new DateOnly(2025, 10, 1);
    var ate = new DateOnly(2026, 6, 30);
    for (var i = 0; i < 400; i++)
    {
        var tipo = TipoAleatorio();
        var linhas = Linhas(de, ate);
        var escada = Escada();
        var jaCarimbados = linhas
            .Select(l => PatamarResolver.Balde(l.DataInicioContrato, tipo).Inicio)
            .Distinct()
            .Where(_ => r.Next(3) == 0)
            .ToHashSet();
        var hoje = Data(de, ate.AddMonths(2));
        var desde = PatamarResolver.Balde(Data(de.AddMonths(-3), ate), tipo).Inicio;
        var aFazer = PatamarFechoPlanner.Planear(linhas, tipo, escada, jaCarimbados, hoje, desde);
        casos.Add(new
        {
            tipo = Tipo(tipo), linhas = LinhasJson(linhas), escada = EscadaJson(escada),
            jaCarimbados = jaCarimbados.Select(D), hoje = D(hoje), desde = D(desde),
            carimbos = aFazer.Select(c => new
            {
                inicio = D(c.Periodo.Inicio), fim = D(c.Periodo.Fim), acumulado = S(c.Acumulado),
                ordem = c.Ordem, percentagemComercial = S(c.PercentagemComercial),
            }),
        });
    }
    Seccao("fechoPlanner", casos);
}

// Líquido com patamar (ComercialService/AdminNegociosService/AcertosService):
//   Math.Round(bruto * margem / 100m, 2, MidpointRounding.AwayFromZero)
{
    var casos = new List<object?>();
    for (var i = 0; i < 800; i++)
    {
        var bruto = Dec(5_000_000, 2, true);
        var margem = Um(Dec(10_000, 2), Dec(100, 0), Dec(1_000_000, 4));
        casos.Add(new { bruto = S(bruto), margem = S(margem), liquido = S(Math.Round(bruto * margem / 100m, 2, MidpointRounding.AwayFromZero)) });
    }
    Seccao("liquidoPatamar", casos);
}

// ─── Acertos: rácio e comercial derivado (AcertosService) ─────────────────────

{
    var casos = new List<object?>();
    for (var i = 0; i < 1500; i++)
    {
        var upBruto = r.Next(10) == 0 ? 0m : Dec(10_000_000, 2);
        var upLiq = Dec(10_000_000, 2);
        var premBruto = r.Next(5) == 0 ? 0m : Dec(1_000_000, 2, true);
        var premLiq = Dec(1_000_000, 2, true);
        var dUp = Talvez(() => Dec(1_000_000, 2, true), 20);
        var dPrem = Talvez(() => Dec(100_000, 2, true), 40);

        // RaciosComercialAsync + ComercialDerivado, à letra.
        var racioUp = upBruto != 0m ? upLiq / upBruto : 0m;
        var racioPrem = premBruto != 0m ? premLiq / premBruto : 0m;
        var comercial = Math.Round((dUp ?? 0m) * racioUp + (dPrem ?? 0m) * racioPrem, 2, MidpointRounding.AwayFromZero);

        casos.Add(new
        {
            upBruto = S(upBruto), upLiq = S(upLiq), premBruto = S(premBruto), premLiq = S(premLiq),
            deltaUpfrontBruto = SN(dUp), deltaPremioBruto = SN(dPrem),
            racioUp = S(racioUp), racioPrem = S(racioPrem), comercial = S(comercial),
        });
    }
    Seccao("acertoDerivado", casos);
}

// ─── Texto: int.TryParse, Trim, IsNullOrWhiteSpace ────────────────────────────

{
    var casos = new List<object?>();
    string[] entradas =
    [
        "12", " 12 ", "+12", "-12", "1 2", "", " ", "12\0", "12\0\0", "12 \0", "12\0 ", "\t12\n", "\u00A012",
        "2147483647", "2147483648", "-2147483648", "-2147483649", "0012", "１２", "12.0", "1e3", "٣", "+-1",
        "--1", "\v12\f", "\u200B12", "\r\n7\r\n", "- 5", "+ 5", "00000000000000000000000000000012", "0", "-0",
        "\u000312", "12abc", "abc", "\u3000" + "4", "8\u2028",
    ];
    foreach (var s in entradas)
        casos.Add(new { texto = s, valor = int.TryParse(s, out var v) ? v : (int?)null });
    Seccao("intTryParse", casos);
}

{
    var casos = new List<object?>();
    string[] entradas =
    [
        "", " ", "  a  ", "\u00A0b\u00A0", "\uFEFFc\uFEFF", "\u0085d\u0085", "\u2028e\u2029", "\u3000f\u3000",
        "\u200Bg\u200B", "\t\n\v\f\rh\r\n", "\u180Ei\u180E", "\u2000\u200Aj", "\u202Fk\u205F", "l", " m n ",
        "\u0000o\u0000", "\u1680p", "\u00A0", "\uFEFF", "\u0085",
        // Maiúsculas: o .NET mapeia carácter a carácter e deixa o i sem ponto como está.
        "\u0131", "\u01C5", "\uFB00", "\u0149", "\u00DF", "\u017F", "\u01F0", "\u0390", "i", "\u01C8", "\uFB06",
    ];
    foreach (var s in entradas)
        casos.Add(new { texto = s, trim = s.Trim(), branco = string.IsNullOrWhiteSpace(s), maiusculas = s.ToUpperInvariant() });
    Seccao("texto", casos);
}

// ─── Observações dos produtos (DealProductCommentsParser.Parse) ───────────────

{
    var casos = new List<object?>();
    void Caso(string? texto)
    {
        object resultado;
        try
        {
            resultado = new
            {
                subscricoes = DealProductCommentsParser.Parse(texto)
                    .Select(s => new { numero = s.Numero, duracaoMeses = s.DuracaoMeses, quantidade = s.Quantidade }),
            };
        }
        catch (Exception e) { resultado = new { erro = e.GetType().Name }; }
        casos.Add(new { texto, resultado });
    }

    const string Aviso = "⚠ Gerado pela app Preencher Produtos — não remover.\n";
    string[] fixos =
    [
        Aviso + """{"subscricoes":[{"numero":"911111111","duracao_meses":30},{"numero":"922222222","duracao_meses":24}]}""",
        """{"subscricoes":[{"numero":"911111111","duracao_meses":30}]}""",
        "", " ", "texto sem json", "{ json invalido", """{"outra_coisa":1}""",
        """{"subscricoes":[{"numero":"911","duracao_meses":24},{"duracao_meses":30,"quantidade":20}]}""",
        """{"subscricoes":[{"duracao_meses":30},{"numero":"911111111","duracao_meses":24}]}""",
        """{"subscricoes":[{"numero":"  912  ","duracao_meses":24,"quantidade":0}]}""",
        """{"subscricoes":[{"numero":"   ","duracao_meses":24,"quantidade":-3}]}""",
        """{"subscricoes":[{"numero":123,"duracao_meses":"24"}]}""",
        """{"subscricoes":[{"duracao_meses":30.0}]}""",
        """{"subscricoes":[{"duracao_meses":1e2}]}""",
        """{"subscricoes":[{"duracao_meses":2147483648}]}""",
        """{"subscricoes":[{"duracao_meses":-0}]}""",
        """{"subscricoes":[{"duracao_meses":24,"quantidade":2.5}]}""",
        """{"subscricoes":[5,"x",null,[],{"duracao_meses":12}]}""",
        """{"subscricoes":{}}""",
        """{"subscricoes":[{"duracao_meses":12}]} fim""",
        """{"subscricoes":[{"duracao_meses":12},]}""",
        """{"subscricoes":[{"duracao_meses":12}]}   """,
        "aviso {x\n" + """{"subscricoes":[{"duracao_meses":12}]}""",
        """{"subscricoes":[{"numero":"\u00A0913\u00A0","duracao_meses":12}]}""",
        """{"subscricoes":[{"numero":"\uFEFF914","duracao_meses":12}]}""",
        """{"subscricoes":[{"numero":"\u0085915\u0085","duracao_meses":12}]}""",
        """{"subscricoes":[{"duracao_meses":12}],"subscricoes":[{"duracao_meses":36}]}""",
        """{"subscricoes":[{"duracao_meses":12,"duracao_meses":18}]}""",
    ];
    foreach (var t in fixos) Caso(t);
    Caso(null);

    // Profundidade máxima do JsonDocument (64).
    foreach (var n in new[] { 62, 63, 64, 65 })
        Caso("{\"x\":" + new string('[', n - 1) + new string(']', n - 1) + ",\"subscricoes\":[{\"duracao_meses\":6}]}");

    string[] numeros = ["\"911111111\"", "\" 912 \"", "\"\"", "\"   \"", "null", "123", "\"\\u00A0913\\u00A0\""];
    string[] duracoes = ["24", "30", "0", "-5", "2147483647", "36", "12"];
    string[] quantidades = ["1", "0", "-3", "20", "5"];
    for (var i = 0; i < 300; i++)
    {
        var itens = Enumerable.Range(0, r.Next(0, 5)).Select(_ =>
        {
            var campos = new List<string>();
            if (r.Next(5) != 0) campos.Add("\"numero\":" + Um(numeros));
            if (r.Next(8) != 0) campos.Add("\"duracao_meses\":" + Um(duracoes));
            if (r.Next(3) == 0) campos.Add("\"quantidade\":" + Um(quantidades));
            if (r.Next(6) == 0) campos.Add("\"extra\":{\"a\":[1,2]}");
            return "{" + string.Join(",", campos.OrderBy(_ => r.Next())) + "}";
        });
        Caso(Um("", Aviso, "  \n") + "{\"subscricoes\":[" + string.Join(",", itens) + "]}");
    }
    Seccao("observacoes", casos);
}

// ─── Escrita ──────────────────────────────────────────────────────────────────

void Gravar(string caminho, List<(string Nome, List<object?> Casos)> lista)
{
    var opcoes = new JsonSerializerOptions { WriteIndented = false };
    var sb = new StringBuilder();
    sb.Append("{\n\"semente\": ").Append(Semente).Append(",\n\"seccoes\": {\n");
    for (var s = 0; s < lista.Count; s++)
    {
        var (nome, casos) = lista[s];
        sb.Append(JsonSerializer.Serialize(nome)).Append(": [\n");
        for (var i = 0; i < casos.Count; i++)
            sb.Append(JsonSerializer.Serialize(casos[i], opcoes)).Append(i < casos.Count - 1 ? ",\n" : "\n");
        sb.Append(s < lista.Count - 1 ? "],\n" : "]\n");
    }
    sb.Append("}\n}\n");
    File.WriteAllText(caminho, sb.ToString(), new UTF8Encoding(false));
    Console.WriteLine($"{caminho}: {string.Join(", ", lista.Select(x => $"{x.Nome}={x.Casos.Count}"))}");
}

Directory.CreateDirectory(pasta);
Gravar(Path.Combine(pasta, "casos-net.json"), seccoes);
Gravar(Path.Combine(pasta, "identity-net.json"), OraculoIdentity.Gerar(new Random(Semente)));
