// Casos do ASP.NET Core Identity (pacote Microsoft.Extensions.Identity.Core, a versão de
// produção): verificação de passwords (PasswordHasher) e 2FA por autenticador
// (AuthenticatorTokenProvider). As peças internas do pacote (Base32 e
// Rfc6238AuthenticationService.ComputeTotp) são chamadas por reflexão — nada é
// reimplementado aqui, para o oráculo ser o próprio Identity.

using System.Buffers.Binary;
using System.Reflection;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Cryptography.KeyDerivation;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

static class OraculoIdentity
{
    public static List<(string Nome, List<object?> Casos)> Gerar(Random r) =>
    [
        ("password", Passwords(r)),
        ("base32Para", Base32Para(r)),
        ("base32De", Base32De(r)),
        ("totp", Totp(r)),
        ("autenticador", Autenticador(r)),
    ];

    // ─── Passwords ────────────────────────────────────────────────────────────

    static readonly PasswordHasher<object> HasherAtual = new(); // V3, HMAC-SHA512, 100 000 iterações

    static string Verificar(string hash, string tentativa)
    {
        try { return HasherAtual.VerifyHashedPassword(null!, hash, tentativa).ToString(); }
        catch (Exception e) { return "erro:" + e.GetType().Name; }
    }

    /// <summary>Um hash V3 com parâmetros escolhidos (PRFs e tamanhos que o .NET já não gera).</summary>
    static string HashV3(string password, KeyDerivationPrf prf, int iteracoes, int tamanhoSalt, int tamanhoSubchave)
    {
        var salt = RandomNumberGenerator.GetBytes(tamanhoSalt);
        var subchave = KeyDerivation.Pbkdf2(password, salt, prf, iteracoes, tamanhoSubchave);
        var bytes = new byte[13 + salt.Length + subchave.Length];
        bytes[0] = 0x01;
        BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(1), (uint)prf);
        BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(5), (uint)iteracoes);
        BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(9), (uint)salt.Length);
        salt.CopyTo(bytes, 13);
        subchave.CopyTo(bytes, 13 + salt.Length);
        return Convert.ToBase64String(bytes);
    }

    static List<object?> Passwords(Random r)
    {
        var casos = new List<object?>();
        void Caso(string tipo, string senha, string hash, params string[] outras)
        {
            var tentativas = new[] { senha, senha + "x", "", senha.ToUpperInvariant() }.Concat(outras).Distinct();
            casos.Add(new
            {
                tipo, senha, hash,
                // O JSON troca um surrogate solto por U+FFFD; nesses casos vão também as
                // unidades UTF-16, para o teste reconstruir a tentativa exata.
                resultados = tentativas.Select(t => new
                {
                    tentativa = t,
                    utf16 = t.Any(char.IsSurrogate) ? t.Select(c => (int)c).ToArray() : null,
                    resultado = Verificar(hash, t),
                }).ToList(),
            });
        }

        var senhas = new List<string>
        {
            "Password1!", "", "a", "pássword çé", "😀 emoji", new string('x', 200), "  espaços  ", "MAIÚSCULAS",
        };
        for (var i = 0; i < 6; i++)
            senhas.Add(new string(Enumerable.Range(0, r.Next(1, 30)).Select(_ => (char)r.Next(33, 127)).ToArray()));

        var hasherV2 = new PasswordHasher<object>(Options.Create(new PasswordHasherOptions
            { CompatibilityMode = PasswordHasherCompatibilityMode.IdentityV2 }));
        var hasher10k = new PasswordHasher<object>(Options.Create(new PasswordHasherOptions { IterationCount = 10_000 }));

        for (var i = 0; i < senhas.Count; i++)
        {
            var s = senhas[i];
            if (i < 4) Caso("v3-atual", s, HasherAtual.HashPassword(null!, s)); // 100 000 iterações: caro
            Caso("v2", s, hasherV2.HashPassword(null!, s));
            Caso("v3-10k", s, hasher10k.HashPassword(null!, s));
            Caso("v3-sha256-10k", s, HashV3(s, KeyDerivationPrf.HMACSHA256, 10_000, 16, 32));
            Caso("v3-sha1-1000", s, HashV3(s, KeyDerivationPrf.HMACSHA1, 1_000, 16, 32));
            Caso("v3-sha512-2000-salt32-sub64", s, HashV3(s, KeyDerivationPrf.HMACSHA512, 2_000, 32, 64));
        }

        // Surrogate solto: o KeyDerivation do .NET codifica em UTF-8 ESTRITO e lança (no V3
        // dentro de um try → Failed; no V2 a exceção sai). O hash é o da mesma password com
        // U+FFFD no lugar do surrogate — o que um UTF-8 permissivo (o do Node) calcularia.
        var surrogate = "Pass" + (char)0xD800 + "word";
        var comSubstituto = "Pass" + (char)0xFFFD + "word";
        Caso("v3-10k", comSubstituto, hasher10k.HashPassword(null!, comSubstituto), surrogate);
        Caso("v2", comSubstituto, hasherV2.HashPassword(null!, comSubstituto), surrogate);

        // Hashes malformados: Failed, ou a exceção que o .NET deixa sair.
        var valido = HashV3("x", KeyDerivationPrf.HMACSHA512, 1_000, 16, 32);
        var bytes = Convert.FromBase64String(valido);
        string Alterado(Action<byte[]> alterar)
        {
            var copia = (byte[])bytes.Clone();
            alterar(copia);
            return Convert.ToBase64String(copia);
        }
        string[] malformados =
        [
            "", "AAAA", "!!!!", "AQAAAA", valido[..^4], valido + "=", valido.Insert(8, " ").Insert(20, "\n"),
            valido.TrimEnd('='), valido.Replace('+', '-').Replace('/', '_'), " " + valido + "\t",
            Alterado(b => b[0] = 0x02),
            Alterado(b => BinaryPrimitives.WriteUInt32BigEndian(b.AsSpan(1), 7)),
            Alterado(b => BinaryPrimitives.WriteUInt32BigEndian(b.AsSpan(5), 0)),
            Alterado(b => BinaryPrimitives.WriteUInt32BigEndian(b.AsSpan(5), 0x80000000)),
            Alterado(b => BinaryPrimitives.WriteUInt32BigEndian(b.AsSpan(9), 8)),
            Alterado(b => BinaryPrimitives.WriteUInt32BigEndian(b.AsSpan(9), 100)),
            Alterado(b => BinaryPrimitives.WriteUInt32BigEndian(b.AsSpan(9), 40)),
            Alterado(b => BinaryPrimitives.WriteUInt32BigEndian(b.AsSpan(9), 0xFFFFFFF0)),
            Alterado(b => b[^1] ^= 1),
            Convert.ToBase64String(bytes[..20]),
            Convert.ToBase64String(bytes[..10]),
            Convert.ToBase64String(new byte[] { 0x00, 1, 2, 3 }),
        ];
        foreach (var h in malformados) Caso("malformado", "x", h);
        return casos;
    }

    // ─── Base32 e TOTP (internos do pacote, por reflexão) ─────────────────────

    static readonly Assembly AssemblyIdentity = typeof(PasswordHasher<>).Assembly;

    static MethodInfo Metodo(string tipo, string nome) =>
        AssemblyIdentity.GetType(tipo, throwOnError: true)!
            .GetMethod(nome, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
        ?? throw new InvalidOperationException($"{tipo}.{nome} não existe nesta versão do Identity.");

    static readonly MethodInfo ParaBase32 = Metodo("Microsoft.AspNetCore.Identity.Base32", "ToBase32");
    static readonly MethodInfo DeBase32 = Metodo("Microsoft.AspNetCore.Identity.Base32", "FromBase32");
    static readonly MethodInfo ComputeTotp = Metodo("Microsoft.AspNetCore.Identity.Rfc6238AuthenticationService", "ComputeTotp");

    static object? Invocar(MethodInfo m, params object?[] args)
    {
        try { return m.Invoke(null, args); }
        catch (TargetInvocationException e) { throw e.InnerException!; }
    }

    static string NovaChave(Random r)
    {
        var bytes = new byte[20];
        r.NextBytes(bytes);
        return (string)Invocar(ParaBase32, bytes)!;
    }

    static int Codigo(byte[] chave, long passo)
    {
        // ComputeTotp(byte[] key, ulong timestepNumber, byte[]? modifierBytes)
        var argumentos = ComputeTotp.GetParameters().Length == 3
            ? new object?[] { chave, (ulong)passo, null }
            : new object?[] { chave, (ulong)passo };
        return (int)Invocar(ComputeTotp, argumentos)!;
    }

    static List<object?> Base32Para(Random r)
    {
        var casos = new List<object?>();
        for (var n = 0; n <= 25; n++)
        {
            var bytes = new byte[n];
            r.NextBytes(bytes);
            casos.Add(new { bytesHex = Convert.ToHexString(bytes), texto = (string)Invocar(ParaBase32, bytes)! });
        }
        return casos;
    }

    static List<object?> Base32De(Random r)
    {
        var entradas = new List<string>
        {
            "", "====", "MZXW6===", "mzxw6", "A", "AB", "ABCDEFGH", "ABCDEFGHIJ", "ABC1", "abc8", "AB CD",
            "ABCDEFGH=", "ab=cd", "zzzzzzzz", "ÀBCD", "ſ", "ı234",
        };
        for (var i = 0; i < 20; i++)
        {
            var chave = NovaChave(r);
            entradas.Add(chave);
            entradas.Add(chave.ToLowerInvariant());
        }
        return entradas.Select(e =>
        {
            try { return (object?)new { texto = e, bytesHex = Convert.ToHexString((byte[])Invocar(DeBase32, e)!) }; }
            catch (Exception ex) { return new { texto = e, erro = ex.GetType().Name }; }
        }).ToList();
    }

    static List<object?> Totp(Random r)
    {
        var casos = new List<object?>();
        int[] tamanhos = [20, 20, 20, 0, 1, 10, 64, 100];
        for (var i = 0; i < 400; i++)
        {
            var chave = new byte[tamanhos[r.Next(tamanhos.Length)]];
            r.NextBytes(chave);
            var passo = r.Next(3) switch
            {
                0 => r.NextInt64(0, 100_000_000),          // à volta de "agora" (≈ 59 milhões)
                1 => r.NextInt64(long.MinValue, long.MaxValue),
                _ => r.Next(0, 3),
            };
            casos.Add(new { chaveHex = Convert.ToHexString(chave), passo = passo.ToString(), codigo = Codigo(chave, passo) });
        }
        return casos;
    }

    // ─── AuthenticatorTokenProvider.ValidateAsync, com o relógio real ─────────

    sealed class Utilizador { public string? Chave; }

    /// <summary>Só o que o AuthenticatorTokenProvider usa: a chave do autenticador.</summary>
    sealed class Loja : IUserAuthenticatorKeyStore<Utilizador>
    {
        public Task<string?> GetAuthenticatorKeyAsync(Utilizador user, CancellationToken ct) => Task.FromResult(user.Chave);
        public Task SetAuthenticatorKeyAsync(Utilizador user, string key, CancellationToken ct) => throw new NotSupportedException();
        public void Dispose() { }
        public Task<string> GetUserIdAsync(Utilizador user, CancellationToken ct) => Task.FromResult("1");
        public Task<string?> GetUserNameAsync(Utilizador user, CancellationToken ct) => Task.FromResult<string?>("u");
        public Task SetUserNameAsync(Utilizador user, string? userName, CancellationToken ct) => throw new NotSupportedException();
        public Task<string?> GetNormalizedUserNameAsync(Utilizador user, CancellationToken ct) => Task.FromResult<string?>("U");
        public Task SetNormalizedUserNameAsync(Utilizador user, string? normalizedName, CancellationToken ct) => throw new NotSupportedException();
        public Task<IdentityResult> CreateAsync(Utilizador user, CancellationToken ct) => throw new NotSupportedException();
        public Task<IdentityResult> UpdateAsync(Utilizador user, CancellationToken ct) => throw new NotSupportedException();
        public Task<IdentityResult> DeleteAsync(Utilizador user, CancellationToken ct) => throw new NotSupportedException();
        public Task<Utilizador?> FindByIdAsync(string userId, CancellationToken ct) => throw new NotSupportedException();
        public Task<Utilizador?> FindByNameAsync(string normalizedUserName, CancellationToken ct) => throw new NotSupportedException();
    }

    static List<object?> Autenticador(Random r)
    {
        var manager = new UserManager<Utilizador>(
            new Loja(), Options.Create(new IdentityOptions()), new PasswordHasher<Utilizador>(),
            [], [], new UpperInvariantLookupNormalizer(), new IdentityErrorDescriber(), null!,
            NullLogger<UserManager<Utilizador>>.Instance);
        var provider = new AuthenticatorTokenProvider<Utilizador>();

        string Validar(string? chave, string? token)
        {
            try { return provider.ValidateAsync("TwoFactor", token!, manager, new Utilizador { Chave = chave }).GetAwaiter().GetResult() ? "true" : "false"; }
            catch (Exception e) { return "erro:" + e.GetType().Name; }
        }

        var chaves = Enumerable.Range(0, 40).Select(_ => NovaChave(r)).ToList();
        chaves.Add(chaves[0].ToLowerInvariant());
        chaves.Add(chaves[1] + "====");

        var casos = new List<object?>();
        foreach (var chave in chaves)
        {
            while (true)
            {
                var agora = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                var bytesChave = (byte[])Invocar(DeBase32, chave)!;
                var tokens = new List<string?> { null, "", "abc", "000000", "1e6", "999999999999" };
                for (var desvio = -3; desvio <= 3; desvio++)
                {
                    var c = Codigo(bytesChave, agora / 30 + desvio);
                    var d6 = c.ToString("D6");
                    tokens.AddRange([d6, c.ToString(), " " + d6 + " ", "+" + d6, "0" + d6, d6 + "\0", d6[..3] + " " + d6[3..], "-" + d6]);
                }
                var resultados = tokens.Select(t => new { token = t, resultado = Validar(chave, t) }).ToList();
                // Se o passo de 30 s virou a meio, os resultados misturam dois "agora": repetir.
                if (DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30 != agora / 30) continue;
                casos.Add(new { chave, agora, resultados });
                break;
            }
        }

        // Chaves inválidas ou vazias.
        foreach (var chave in new[] { null, "", "   ", "ABC1ABC1ABC1ABC1", "AB CDEFGHIJKLMNOP" })
            casos.Add(new
            {
                chave, agora = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                resultados = new[] { "123456", "abc" }.Select(t => new { token = (string?)t, resultado = Validar(chave, t) }).ToList(),
            });
        return casos;
    }
}
