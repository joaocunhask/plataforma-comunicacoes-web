"use client";

// O modal "Preencher produtos": colar o texto do simulador, rever as linhas resolvidas e
// aplicá-las ao negócio, criando negócios-irmãos para os produtos de outros funis.
// Port de UI/Components/Pages/Pipedrive/UpfrontModal.razor.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import AppExtensionsSDK from "@pipedrive/app-extensions-sdk";
import { lerNumeros } from "@/lib/modal/subscricoes";

type Estado = "a-verificar" | "autorizar" | "colar" | "rever" | "a-aplicar" | "feito";

interface Candidato {
  pipedriveProductId: number;
  pricingPlanId: string;
  nome: string;
}
interface FunilAlvo {
  idFunil: number;
  objetivo: string | null;
  nomeFunil: string | null;
  sugerido: boolean;
}
interface ItemCatalogo {
  productId: number;
  nome: string;
  pricingPlanId: string;
}
interface Linha {
  chave: number;
  nomeProduto: string;
  quantidade: number;
  duracaoMeses: number;
  multaMensal: string; // texto: o dinheiro não passa por float
  pricingPlanId: string;
  pipedriveProductId: number | null;
  nomeCanonico: string | null;
  status: string;
  numerosRaw: string;
  isManual: boolean;
  pesquisa: string;
  mostrarResultados: boolean;
  origemResolucao: string | null;
  candidatos: Candidato[];
  classificacao: string | null;
  atingimento: string | null;
  funisAlvo: FunilAlvo[];
  porExcecao: boolean;
  incluida: boolean;
  motivo: string;
}
interface Grupo {
  chave: number;
  funilSelecionado: number;
  titulo: string;
  linhas: number[]; // chaves das linhas
  opcoes: FunilAlvo[];
  aCriar: boolean;
  dealCriado: number | null;
  erro: string | null;
}
interface Ignorada {
  nomeProduto: string;
  motivo: string;
}

const etiqueta = (f: FunilAlvo) => f.objetivo ?? f.nomeFunil ?? `funil ${f.idFunil}`;
const motivoValido = (m: string | null | undefined) => !!m && m.trim().length >= 5;
const multaPositiva = (m: string) => Number(m.replace(",", ".")) > 0;
const temDuplicados = (nums: string[]) => new Set(nums.map((n) => n.toLowerCase())).size !== nums.length;
const plural = (n: number, s = "s") => (n === 1 ? "" : s);
let proximaChave = 1;
const novaChave = () => proximaChave++;

function linhaVazia(manual: boolean): Linha {
  return {
    chave: novaChave(),
    nomeProduto: "",
    quantidade: 1,
    duracaoMeses: 0,
    multaMensal: "",
    pricingPlanId: "",
    pipedriveProductId: null,
    nomeCanonico: null,
    status: "",
    numerosRaw: "",
    isManual: manual,
    pesquisa: "",
    mostrarResultados: false,
    origemResolucao: null,
    candidatos: [],
    classificacao: null,
    atingimento: null,
    funisAlvo: [],
    porExcecao: false,
    incluida: false,
    motivo: "",
  };
}

async function lerErro(r: Response): Promise<string | null> {
  try {
    const j = await r.json();
    return typeof j?.error === "string" && j.error.trim() ? j.error : null;
  } catch {
    return null;
  }
}

/** O JSON das respostas com a multa como texto exato (o número vem do servidor com as casas). */
async function lerJsonComMultas<T>(r: Response): Promise<T> {
  const texto = await r.text();
  return JSON.parse(texto, (k, v, ctx?: { source?: string }) => (k === "multaMensal" && typeof v === "number" ? (ctx?.source ?? String(v)) : v)) as T;
}

export function ModalPreencherProdutos() {
  const params = useSearchParams();
  const tokenRef = useRef<string | null>(params.get("token"));
  const dealId = (() => {
    const n = Number((params.get("selectedIds") ?? "").split(",")[0]);
    return Number.isInteger(n) && n > 0 ? n : 0;
  })();

  const [estado, setEstado] = useState<Estado>("a-verificar");
  const [erro, setErro] = useState<string | null>(null);
  const [texto, setTexto] = useState("");
  const [aAnalisar, setAAnalisar] = useState(false);
  const [idSimulador, setIdSimulador] = useState("");
  const [linhas, setLinhas] = useState<Linha[]>([]); // as deste negócio
  const [outros, setOutros] = useState<Linha[]>([]); // as de outros funis
  const [grupos, setGrupos] = useState<Grupo[]>([]);
  const [ignoradas, setIgnoradas] = useState<Ignorada[]>([]);
  const [classificacaoAtiva, setClassificacaoAtiva] = useState(false);
  const [objetivoDoNegocio, setObjetivoDoNegocio] = useState<string | null>(null);
  const [tituloNegocio, setTituloNegocio] = useState<string | null>(null);
  const [motivoSemClassificacao, setMotivoSemClassificacao] = useState<string | null>(null);
  const [catalogo, setCatalogo] = useState<ItemCatalogo[] | null>(null);
  const [aCarregarCatalogo, setACarregarCatalogo] = useState(false);

  const api = useCallback(
    (caminho: string, init: RequestInit = {}) =>
      fetch(caminho, {
        ...init,
        headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${tokenRef.current ?? ""}` },
      }),
    [],
  );

  // Handshake com o Pipedrive: sem ele em ~10 s, o Pipedrive mata o iframe.
  // Fora do Pipedrive (sem ?id=) o construtor lança: não pode deitar o ecrã abaixo.
  useEffect(() => {
    try {
      new AppExtensionsSDK().initialize({ size: { height: 720, width: 900 } }).catch((e) => console.error("[pd-modal] SDK init falhou", e));
    } catch (e) {
      console.error("[pd-modal] SDK indisponível (aberto fora do Pipedrive?)", e);
    }
  }, []);

  // Ao abrir: estado do OAuth e troca do JWT de ~5 min por um de 30 min.
  useEffect(() => {
    (async () => {
      if (!tokenRef.current) {
        setErro("Sessão expirada. Reabre o modal a partir do Pipedrive.");
        setEstado("autorizar");
        return;
      }
      try {
        const r = await api("/pipedrive/oauth/status");
        if (!r.ok) {
          setErro(`Não foi possível verificar autorização (${r.status}).`);
          setEstado("autorizar");
          return;
        }
        const status = (await r.json()) as { hasToken: boolean };
        try {
          const s = await api("/pipedrive/session/extend", { method: "POST" });
          if (s.ok) {
            const novo = (await s.json()) as { token?: string };
            if (novo.token) tokenRef.current = novo.token;
          }
        } catch {
          /* fica com o token original (janela curta) */
        }
        setEstado(status.hasToken ? "colar" : "autorizar");
      } catch {
        setErro("Erro inesperado ao verificar autorização.");
        setEstado("autorizar");
      }
    })();
  }, [api]);

  // ── Autorização (popup OAuth) ──
  async function autorizar() {
    setErro(null);
    const r = await api("/pipedrive/oauth/start");
    if (!r.ok) {
      setErro(`Não foi possível iniciar autorização (${r.status}).`);
      return;
    }
    const { authorizeUrl } = (await r.json()) as { authorizeUrl?: string };
    if (!authorizeUrl) {
      setErro("Resposta inválida do servidor.");
      return;
    }
    const aoReceber = (ev: MessageEvent) => {
      if (ev.data === "pipedrive_authorized") {
        window.removeEventListener("message", aoReceber);
        setEstado("colar");
      } else if (ev.data === "pipedrive_auth_failed") {
        window.removeEventListener("message", aoReceber);
        setErro("Autorização falhou. Tenta outra vez.");
      }
    };
    window.addEventListener("message", aoReceber);
    window.open(authorizeUrl, "pdOAuth", "width=600,height=700");
  }

  // ── Catálogo (seletor manual) ──
  async function garantirCatalogo(): Promise<boolean> {
    if (catalogo) return true;
    setACarregarCatalogo(true);
    try {
      const r = await api("/pipedrive/catalog");
      if (!r.ok) {
        setErro(r.status === 400 ? ((await lerErro(r)) ?? "Não foi possível carregar o catálogo.") : "Não foi possível carregar o catálogo de produtos. Tenta novamente.");
        return false;
      }
      setCatalogo((await r.json()) as ItemCatalogo[]);
      return true;
    } catch {
      setErro("Erro inesperado ao carregar o catálogo.");
      return false;
    } finally {
      setACarregarCatalogo(false);
    }
  }

  const filtrar = (termo: string) => {
    const t = termo.trim().toLowerCase();
    const base = catalogo ?? [];
    return (t ? base.filter((p) => p.nome.toLowerCase().includes(t) || p.pricingPlanId.toLowerCase().includes(t)) : base).slice(0, 20);
  };

  // ── Edição das linhas (deste negócio e de outros funis) ──
  const editar = (chave: number, mudar: (l: Linha) => Partial<Linha>) => {
    setLinhas((ls) => ls.map((l) => (l.chave === chave ? { ...l, ...mudar(l) } : l)));
    setOutros((ls) => ls.map((l) => (l.chave === chave ? { ...l, ...mudar(l) } : l)));
  };

  function construirGrupos(deOutros: Linha[], titulo: string | null, existentes: Grupo[] = []): Grupo[] {
    const gs = existentes.map((g) => ({ ...g, linhas: [...g.linhas], opcoes: [...g.opcoes] }));
    for (const l of deOutros) {
      // O sugerido (tipo de receita do negócio) manda no agrupamento; sem ele, o primeiro.
      const preferido = l.funisAlvo.find((f) => f.sugerido) ?? l.funisAlvo[0];
      if (!preferido) continue;
      let g = gs.find((x) => x.funilSelecionado === preferido.idFunil && x.dealCriado === null);
      if (!g) {
        g = {
          chave: novaChave(),
          funilSelecionado: preferido.idFunil,
          titulo: titulo ? `${titulo} — ${etiqueta(preferido)}` : etiqueta(preferido),
          linhas: [],
          opcoes: [...l.funisAlvo],
          aCriar: false,
          dealCriado: null,
          erro: null,
        };
        gs.push(g);
      }
      g.linhas.push(l.chave);
      for (const op of l.funisAlvo) if (!g.opcoes.some((o) => o.idFunil === op.idFunil)) g.opcoes.push(op);
    }
    return gs;
  }

  // ── Analisar ──
  async function analisar() {
    if (!texto.trim()) return;
    setAAnalisar(true);
    setErro(null);
    try {
      const r = await api("/pipedrive/contract/extract", { method: "POST", body: JSON.stringify({ rawText: texto, dealId }) });
      if (!r.ok) {
        if (r.status === 401 && (await r.clone().text()).includes("authorization_required")) {
          setErro("A autorização expirou. Por favor autoriza novamente.");
          setEstado("autorizar");
          return;
        }
        setErro(
          r.status === 400
            ? ((await lerErro(r)) ?? "Pedido inválido.")
            : r.status === 429
              ? "Demasiadas análises seguidas. Espera um pouco e tenta novamente."
              : r.status === 403
                ? "Empresa não registada. Contacta o admin."
                : r.status === 502
                  ? "Falha ao contactar Claude/Pipedrive. Tenta novamente."
                  : r.status === 401
                    ? "Sessão inválida. Reabre o modal a partir do Pipedrive."
                    : `Erro do servidor (${r.status}).`,
        );
        return;
      }
      type Resposta = {
        linhas: Omit<Linha, "chave" | "numerosRaw" | "isManual" | "pesquisa" | "mostrarResultados" | "incluida" | "motivo">[];
        linhasIgnoradas: Ignorada[];
        classificacaoAtiva: boolean;
        motivoInativa: string | null;
        objetivoDoNegocio: string | null;
        tituloNegocio: string | null;
      };
      const p = await lerJsonComMultas<Resposta>(r);
      setIgnoradas(p.linhasIgnoradas ?? []);
      if (!p.linhas?.length) {
        setErro(
          p.linhasIgnoradas?.length
            ? `Nenhum produto comissionável no texto — as ${p.linhasIgnoradas.length} linhas encontradas não têm duração de contrato e multa mensal.`
            : "Não foi possível identificar produtos no texto. Confirma que colaste a tabela de produtos do simulador.",
        );
        return;
      }
      setClassificacaoAtiva(p.classificacaoAtiva);
      setObjetivoDoNegocio(p.objetivoDoNegocio);
      setTituloNegocio(p.tituloNegocio);
      setMotivoSemClassificacao(p.classificacaoAtiva ? null : p.motivoInativa);

      const todas: Linha[] = p.linhas.map((l) => ({ ...linhaVazia(false), ...l, multaMensal: String(l.multaMensal), candidatos: l.candidatos ?? [], funisAlvo: l.funisAlvo ?? [] }));
      // Só se separa com prova positiva de outro funil; o não classificado fica aqui.
      const deOutros = todas.filter((l) => l.classificacao === "outro_funil");
      const deste = todas.filter((l) => l.classificacao !== "outro_funil");
      setLinhas(deste);
      setOutros(deOutros);
      setGrupos(construirGrupos(deOutros, p.tituloNegocio));
      if (deste.length === 0 && deOutros.length > 0)
        setErro(
          (deOutros.length === 1
            ? "O único produto comissionável desta simulação pertence a outro funil."
            : `Os ${deOutros.length} produtos comissionáveis desta simulação pertencem a outros funis.`) +
            ' Cria o negócio no funil certo em baixo ou, se for aceite aqui, usa "Incluir neste negócio".',
        );
      setEstado("rever");
    } catch {
      setErro("Erro inesperado ao analisar o texto.");
    } finally {
      setAAnalisar(false);
    }
  }

  function editarTexto() {
    setErro(null);
    setLinhas([]);
    setIgnoradas([]);
    setOutros([]);
    setGrupos([]);
    setClassificacaoAtiva(false);
    setObjetivoDoNegocio(null);
    setTituloNegocio(null);
    setMotivoSemClassificacao(null);
    setEstado("colar");
  }

  function remover(chave: number) {
    setLinhas((ls) => ls.filter((l) => l.chave !== chave));
    setOutros((ls) => ls.filter((l) => l.chave !== chave));
    setGrupos((gs) => gs.map((g) => ({ ...g, linhas: g.linhas.filter((c) => c !== chave) })).filter((g) => g.linhas.length > 0));
  }

  // Só se inclui uma linha que ainda não foi para um negócio novo (senão a comissão duplicava).
  const podeIncluir = (chave: number) => !grupos.some((g) => g.linhas.includes(chave) && (g.dealCriado !== null || g.aCriar));

  function incluir(l: Linha) {
    if (!podeIncluir(l.chave)) return;
    setOutros((ls) => ls.filter((x) => x.chave !== l.chave));
    setGrupos((gs) => gs.map((g) => ({ ...g, linhas: g.linhas.filter((c) => c !== l.chave) })).filter((g) => g.linhas.length > 0));
    setLinhas((ls) => [...ls, { ...l, incluida: true }]);
    setErro(null);
  }

  function deixarDeIncluir(l: Linha) {
    setLinhas((ls) => ls.filter((x) => x.chave !== l.chave));
    const devolvida = { ...l, incluida: false };
    setOutros((ls) => [...ls, devolvida]);
    setGrupos((gs) => construirGrupos([devolvida], tituloNegocio, gs));
  }

  function escolherCandidato(l: Linha, c: Candidato) {
    editar(l.chave, () => ({ pipedriveProductId: c.pipedriveProductId, pricingPlanId: c.pricingPlanId, nomeCanonico: c.nome, origemResolucao: "manual", status: "ok", candidatos: [] }));
  }

  async function resolverManualmente(l: Linha) {
    setErro(null);
    if (!(await garantirCatalogo())) return;
    editar(l.chave, (x) => ({ isManual: true, pesquisa: x.nomeProduto, candidatos: [], status: "" }));
  }

  function escolherProduto(l: Linha, p: ItemCatalogo) {
    editar(l.chave, () => ({ nomeProduto: p.nome, nomeCanonico: p.nome, pricingPlanId: p.pricingPlanId, pipedriveProductId: p.productId, status: "ok", origemResolucao: "manual", pesquisa: p.nome, mostrarResultados: false }));
  }

  async function adicionarManualmente() {
    setErro(null);
    if (!(await garantirCatalogo())) return;
    setLinhas([linhaVazia(true)]);
    setEstado("rever");
  }

  async function adicionarProduto() {
    setErro(null);
    if (!(await garantirCatalogo())) return;
    setLinhas((ls) => [...ls, linhaVazia(true)]);
  }

  function atualizarFunilDoGrupo(g: Grupo, valor: string) {
    const id = Number(valor);
    if (!Number.isInteger(id)) return;
    const anterior = g.opcoes.find((o) => o.idFunil === g.funilSelecionado);
    const novo = g.opcoes.find((o) => o.idFunil === id);
    const sugerido = (f: FunilAlvo | undefined) => (tituloNegocio ? `${tituloNegocio} — ${f ? etiqueta(f) : ""}` : f ? etiqueta(f) : "");
    setGrupos((gs) =>
      gs.map((x) =>
        x.chave !== g.chave
          ? x
          : { ...x, funilSelecionado: id, titulo: novo && x.titulo === sugerido(anterior) ? sugerido(novo) : x.titulo }, // nunca por cima do que o comercial escreveu
      ),
    );
  }

  const paraPedido = (l: Linha) => {
    const numeros = lerNumeros(l.numerosRaw);
    return {
      nomeProduto: l.nomeProduto,
      quantidade: numeros.length > 0 ? numeros.length : l.quantidade,
      duracaoMeses: l.duracaoMeses,
      multaMensal: l.multaMensal.replace(",", "."),
      pricingPlanId: l.pricingPlanId,
      pipedriveProductId: l.pipedriveProductId,
      numerosAssociados: numeros,
      motivoForaDoFunil: l.incluida ? l.motivo.trim() : null,
    };
  };

  const linhasDoGrupo = (g: Grupo) => g.linhas.map((c) => outros.find((l) => l.chave === c)).filter((l): l is Linha => !!l);
  const podeCriar = (g: Grupo) => {
    const ls = linhasDoGrupo(g);
    return !g.aCriar && g.dealCriado === null && ls.length > 0 && !!idSimulador.trim() && !!g.titulo.trim() && ls.every((l) => l.status === "ok" && multaPositiva(l.multaMensal) && l.duracaoMeses > 0);
  };
  const editarGrupo = (chave: number, mudar: Partial<Grupo>) => setGrupos((gs) => gs.map((g) => (g.chave === chave ? { ...g, ...mudar } : g)));

  // ⚠️ Escreve no CRM do parceiro e não há como desfazer por aqui. A API verifica duplicados
  // pelo ID do simulador.
  async function criarNegocio(g: Grupo) {
    if (g.aCriar || g.dealCriado !== null) return;
    if (!idSimulador.trim()) return editarGrupo(g.chave, { erro: "Preenche primeiro o ID do simulador." });
    if (!g.titulo.trim()) return editarGrupo(g.chave, { erro: "O negócio precisa de um título." });
    if (dealId <= 0) return editarGrupo(g.chave, { erro: "Não foi possível determinar o negócio actual." });
    editarGrupo(g.chave, { aCriar: true, erro: null });
    try {
      const r = await api("/pipedrive/contract/criar-negocio", {
        method: "POST",
        body: JSON.stringify({
          rawText: texto,
          idSimulacao: idSimulador.trim(),
          dealOrigemId: dealId,
          pipelineId: g.funilSelecionado,
          titulo: g.titulo.trim(),
          linhas: linhasDoGrupo(g).map(paraPedido),
        }),
      });
      if (!r.ok) {
        const msg =
          r.status === 409
            ? ((await lerErro(r)) ?? "Já existe um negócio desta simulação neste funil.")
            : r.status === 400
              ? ((await lerErro(r)) ?? "Pedido inválido.")
              : r.status === 401
                ? "Sessão inválida. Reabre o modal a partir do Pipedrive."
                : r.status === 502
                  ? "Falha ao contactar o Pipedrive. Tenta novamente."
                  : `Erro do servidor (${r.status}).`;
        editarGrupo(g.chave, { erro: msg, aCriar: false });
        return;
      }
      const p = (await r.json()) as { status: string; dealId: number; errors: { error: string }[] };
      editarGrupo(g.chave, {
        aCriar: false,
        dealCriado: p.dealId,
        // Metade do trabalho feito não é sucesso: dizer exatamente o que falhou.
        erro: p.status !== "success" ? `Negócio criado (#${p.dealId}), mas ${p.errors.length} produto(s) falharam: ${p.errors.map((e) => e.error).join("; ")}` : null,
      });
    } catch {
      editarGrupo(g.chave, { erro: "Erro inesperado ao criar o negócio.", aCriar: false });
    }
  }

  const podeAplicar =
    linhas.length > 0 &&
    !!idSimulador.trim() &&
    linhas.every((l) => l.status === "ok") &&
    linhas.every((l) => multaPositiva(l.multaMensal) && l.duracaoMeses > 0) &&
    linhas.every((l) => !l.incluida || motivoValido(l.motivo));

  async function aplicar() {
    setErro(null);
    if (dealId <= 0) {
      setErro("Não foi possível determinar o negócio actual (selectedIds em falta).");
      return;
    }
    setEstado("a-aplicar");
    try {
      const r = await api("/pipedrive/contract/apply", {
        method: "POST",
        body: JSON.stringify({ rawText: texto, idSimulacao: idSimulador.trim(), dealId, linhas: linhas.map(paraPedido) }),
      });
      if (!r.ok) {
        if (r.status === 401 && (await r.clone().text()).includes("authorization_required")) {
          setErro("A autorização expirou. Por favor autoriza novamente.");
          setEstado("autorizar");
          return;
        }
        setErro(
          r.status === 400
            ? ((await lerErro(r)) ?? "Pedido inválido.")
            : r.status === 429
              ? "Demasiados pedidos seguidos. Espera um pouco e tenta novamente."
              : r.status === 403
                ? "Sem permissão. Verifica que o teu utilizador está registado."
                : r.status === 502
                  ? "Falha ao contactar o Pipedrive. Tenta novamente."
                  : r.status === 401
                    ? "Sessão inválida. Reabre o modal a partir do Pipedrive."
                    : `Erro do servidor (${r.status}).`,
        );
        setEstado("rever");
        return;
      }
      const p = (await r.json()) as { status: string; applied: unknown[]; errors: { error: string }[] };
      const erros = p.errors.map((e) => e.error).join("; ");
      if (p.status === "failed") {
        setErro(`Nenhum produto foi aplicado. Erros: ${erros}`);
        setEstado("rever");
        return;
      }
      if (p.status === "partial") setErro(`${p.applied.length} produto(s) aplicados, ${p.errors.length} falharam: ${erros}`);
      setEstado("feito");
    } catch {
      setErro("Erro inesperado ao aplicar.");
      setEstado("rever");
    }
  }

  // ── Ecrãs ──
  if (estado === "a-verificar")
    return (
      <section className="pd-block pd-center">
        <div className="pd-spinner" />
        <div>A verificar autorização…</div>
      </section>
    );

  if (estado === "autorizar")
    return (
      <section className="pd-block">
        <h2 className="pd-title">Autorização necessária</h2>
        <p className="pd-sub">Primeira vez a usar esta app? Precisas de dar acesso à tua conta Pipedrive para adicionar produtos aos negócios. É só uma vez.</p>
        {erro && <div className="pd-error">{erro}</div>}
        <div className="pd-actions">
          <button className="pd-btn pd-btn-primary" onClick={autorizar}>
            Autorizar Pipedrive
          </button>
        </div>
        <p className="pd-sub" style={{ marginTop: 16, fontSize: 12 }}>
          Vai abrir uma pequena janela. Se o browser bloquear, permite popups deste site.
        </p>
      </section>
    );

  if (estado === "colar")
    return (
      <section className="pd-block">
        <h2 className="pd-title">Contrato — Preencher produtos</h2>
        <p className="pd-sub">Cola aqui o texto do simulador com os produtos. Uma linha por produto.</p>
        <textarea className="pd-textarea" rows={14} placeholder="Cola o texto do simulador aqui..." value={texto} onChange={(e) => setTexto(e.target.value)} />
        {erro && <div className="pd-error">{erro}</div>}
        <div className="pd-actions">
          <button className="pd-btn pd-btn-secondary" disabled={aAnalisar || aCarregarCatalogo} onClick={adicionarManualmente}>
            {aCarregarCatalogo ? "A carregar…" : "Adicionar produtos manualmente"}
          </button>
          <button className="pd-btn pd-btn-primary" disabled={aAnalisar || !texto.trim()} onClick={analisar}>
            {aAnalisar ? (
              <span className="pd-btn-loading">
                <span className="pd-btn-spinner" aria-hidden="true" />
                <span>A analisar…</span>
              </span>
            ) : (
              <span>Analisar</span>
            )}
          </button>
        </div>
      </section>
    );

  if (estado === "a-aplicar")
    return (
      <section className="pd-block pd-center">
        <div className="pd-spinner" />
        <div>A aplicar produtos no negócio…</div>
      </section>
    );

  if (estado === "feito")
    return (
      <section className="pd-block pd-center">
        <div className="pd-success">✓ Produtos aplicados ao negócio.</div>
        {erro && <div className="pd-error">{erro}</div>}
        <p className="pd-sub">Pode fechar este modal.</p>
      </section>
    );

  // estado === "rever"
  return (
    <section className="pd-block">
      <h2 className="pd-title">Revê os produtos</h2>
      <p className="pd-sub">
        {linhas.length} produto{plural(linhas.length)}
        {classificacaoAtiva && objetivoDoNegocio ? (
          <>
            {" "}
            neste negócio (<strong>{objetivoDoNegocio}</strong>).
          </>
        ) : (
          "."
        )}{" "}
        O <strong>número associado</strong> é opcional (informativo). Podes adicionar produtos em falta com <strong>＋ Adicionar produto</strong>.
      </p>

      {!classificacaoAtiva && motivoSemClassificacao && (
        <div className="pd-sem-classificacao">
          <strong>Sem indicação de funil.</strong> {motivoSemClassificacao} Os produtos aparecem todos e podem ser aplicados normalmente.
        </div>
      )}

      <div className="pd-field pd-field-full pd-simulador">
        <label>ID do simulador *</label>
        <input type="text" placeholder="Identificador da simulação (obrigatório)" value={idSimulador} onChange={(e) => setIdSimulador(e.target.value)} />
        {!idSimulador.trim() && <span className="pd-simulador-hint">Necessário para aplicar — é o que liga este negócio à simulação.</span>}
      </div>

      <div className="pd-cards">
        {[...linhas, ...outros].map((l) => {
          const nums = lerNumeros(l.numerosRaw);
          const porResolver = ["ppid_desconhecido", "ambiguo", "nao_encontrado"].includes(l.status);
          const outroFunil = l.classificacao === "outro_funil" && !l.incluida;
          const etiquetaOrigem = { ppid: "PPID lido do texto", nome: "identificado pelo nome", manual: "escolhido por ti" }[l.origemResolucao ?? ""];
          return (
            <div key={l.chave} className={`pd-card ${porResolver ? "pd-card-warn" : ""} ${outroFunil ? "pd-card-outro" : ""} ${l.incluida ? "pd-card-incluida" : ""}`}>
              {outroFunil ? (
                <div className="pd-card-destino">
                  <span>Não pertence a este funil — entra no negócio a criar em baixo.</span>
                  {podeIncluir(l.chave) && (
                    <button type="button" className="pd-link-btn" onClick={() => incluir(l)}>
                      Incluir neste negócio
                    </button>
                  )}
                </div>
              ) : (
                l.incluida && (
                  <div className="pd-card-incluida-nota">
                    <div>
                      <strong>Incluído neste negócio com aviso.</strong> Pelo catálogo conta para {l.atingimento ?? "outra linha"}. Explica porquê — fica registado com o negócio.
                    </div>
                    <textarea
                      rows={2}
                      maxLength={500}
                      className={!motivoValido(l.motivo) ? "pd-motivo-falta" : ""}
                      placeholder="Motivo (obrigatório)"
                      value={l.motivo}
                      onChange={(e) => editar(l.chave, () => ({ motivo: e.target.value }))}
                    />
                    <div className="pd-card-incluida-acoes">
                      {!motivoValido(l.motivo) && <span className="pd-motivo-hint">Escreve o motivo para poder aplicar.</span>}
                      <button type="button" className="pd-link-btn" onClick={() => deixarDeIncluir(l)}>
                        Não incluir
                      </button>
                    </div>
                  </div>
                )
              )}

              <div className="pd-card-header">
                <div className="pd-card-title">
                  {l.isManual && l.status !== "ok" ? (
                    <span>Novo produto</span>
                  ) : (
                    <>
                      <span>{l.nomeProduto}</span>
                      {l.nomeCanonico && l.nomeCanonico.toLowerCase() !== l.nomeProduto.toLowerCase() && <span className="pd-card-canonico">→ {l.nomeCanonico}</span>}
                      {etiquetaOrigem && <span className="pd-badge-origem">{etiquetaOrigem}</span>}
                      {classificacaoAtiva && l.classificacao === "pertence" && l.atingimento && (
                        <>
                          <span className="pd-badge-funil" title="Conta para esta linha de atingimento">
                            {l.atingimento}
                          </span>
                          {l.porExcecao && (
                            <span className="pd-badge-excecao" title="Aceite neste funil por uma exceção registada pela Brasfone">
                              exceção
                            </span>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
                <button type="button" className="pd-card-remove" title="Remover linha" onClick={() => remover(l.chave)}>
                  ✕
                </button>
              </div>

              {l.status === "ppid_desconhecido" && (
                <div className="pd-card-warn-note">
                  PPID <code>{l.pricingPlanId}</code> não existe no catálogo Pipedrive.{" "}
                  <button type="button" className="pd-link-btn" onClick={() => resolverManualmente(l)}>
                    Escolher produto
                  </button>
                </div>
              )}
              {l.status === "nao_encontrado" && (
                <div className="pd-card-warn-note">
                  Não encontrei <strong>{l.nomeProduto}</strong> no catálogo Pipedrive.{" "}
                  <button type="button" className="pd-link-btn" onClick={() => resolverManualmente(l)}>
                    Escolher produto
                  </button>
                </div>
              )}
              {l.status === "ambiguo" && (
                <div className="pd-card-warn-note">
                  Há {l.candidatos.length} produtos com este nome. Escolhe qual foi vendido — a classificação difere entre eles e afeta a comissão.
                  <div className="pd-candidatos">
                    {l.candidatos.map((c) => (
                      <button key={c.pipedriveProductId} type="button" className="pd-combo-item" onClick={() => escolherCandidato(l, c)}>
                        <span className="pd-combo-nome">{c.nome}</span>
                        <span className="pd-combo-ppid">{c.pricingPlanId}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="pd-grid">
                {l.isManual ? (
                  <div className="pd-field pd-combo">
                    <label>Produto *</label>
                    <input
                      type="text"
                      placeholder="Pesquisa por nome ou PPID…"
                      value={l.pesquisa}
                      onChange={(e) => editar(l.chave, () => ({ pesquisa: e.target.value, mostrarResultados: true, status: "", pipedriveProductId: null, pricingPlanId: "" }))}
                    />
                    {l.mostrarResultados && l.pesquisa.trim() && (
                      <div className="pd-combo-list">
                        {filtrar(l.pesquisa).map((p) => (
                          <button key={p.productId} type="button" className="pd-combo-item" onClick={() => escolherProduto(l, p)}>
                            <span className="pd-combo-nome">{p.nome}</span>
                            <span className="pd-combo-ppid">{p.pricingPlanId}</span>
                          </button>
                        ))}
                        {filtrar(l.pesquisa).length === 0 && <div className="pd-combo-empty">Sem resultados.</div>}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="pd-field">
                    <label>Nome (do texto)</label>
                    <input type="text" value={l.nomeProduto} onChange={(e) => editar(l.chave, () => ({ nomeProduto: e.target.value }))} />
                  </div>
                )}
                <div className="pd-field">
                  <label>Pricing Plan ID</label>
                  <input type="text" value={l.pricingPlanId} readOnly className="pd-readonly" />
                </div>
                <div className="pd-field pd-field-small">
                  <label>Quantidade</label>
                  {nums.length > 0 ? (
                    <input type="number" value={nums.length} readOnly className="pd-readonly" title="Definida pelo nº de números associados" />
                  ) : (
                    <input type="number" min={1} value={l.quantidade} onChange={(e) => editar(l.chave, () => ({ quantidade: Math.trunc(Number(e.target.value)) || 0 }))} />
                  )}
                </div>
                <div className="pd-field pd-field-small">
                  <label>Duração (meses)</label>
                  <input type="number" min={0} value={l.duracaoMeses} onChange={(e) => editar(l.chave, () => ({ duracaoMeses: Math.trunc(Number(e.target.value)) || 0 }))} />
                </div>
                <div className="pd-field pd-field-small">
                  <label>Multa mensal (€)</label>
                  <input type="number" step="0.01" min={0} value={l.multaMensal} onChange={(e) => editar(l.chave, () => ({ multaMensal: e.target.value }))} />
                </div>
                <div className="pd-field pd-field-full">
                  <label>Números associados (opcional)</label>
                  <textarea
                    className="pd-numeros"
                    rows={2}
                    placeholder="Cola um número por linha (ou separados por vírgula/espaço). Cada número = uma subscrição."
                    value={l.numerosRaw}
                    onChange={(e) => editar(l.chave, () => ({ numerosRaw: e.target.value }))}
                  />
                  {nums.length > 0 && (
                    <span className="pd-numeros-info">
                      {nums.length} número{plural(nums.length)}
                      {temDuplicados(nums) && <span className="pd-numeros-warn"> · ⚠ há números repetidos</span>}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {outros.length > 0 && (
        <div className="pd-outros-funis">
          <div className="pd-outros-titulo">
            {outros.length} produto{plural(outros.length)} pertence{plural(outros.length, "m")} a outro{plural(outros.length)} funi{outros.length === 1 ? "l" : "s"}
          </div>
          {grupos.map((g) => (
            <div key={g.chave} className="pd-outros-grupo">
              <div className="pd-outros-destino">
                {linhasDoGrupo(g)
                  .map((l) => l.nomeCanonico ?? l.nomeProduto)
                  .join(" · ")}
              </div>
              {g.dealCriado !== null ? (
                <div className="pd-grupo-ok">
                  ✓ Negócio <strong>#{g.dealCriado}</strong> criado com estes produtos.
                </div>
              ) : (
                <div className="pd-grupo-form">
                  <div className="pd-field">
                    <label>Funil de destino</label>
                    <select value={g.funilSelecionado} onChange={(e) => atualizarFunilDoGrupo(g, e.target.value)}>
                      {g.opcoes.map((op) => (
                        <option key={op.idFunil} value={op.idFunil}>
                          {etiqueta(op)}
                          {op.sugerido ? "" : " (outro tipo de receita)"}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="pd-field">
                    <label>Título do novo negócio</label>
                    <input type="text" value={g.titulo} onChange={(e) => editarGrupo(g.chave, { titulo: e.target.value })} />
                  </div>
                  <button className="pd-btn pd-btn-primary" disabled={!podeCriar(g)} onClick={() => criarNegocio(g)}>
                    {g.aCriar ? (
                      <span className="pd-btn-loading">
                        <span className="pd-btn-spinner" aria-hidden="true" />
                        <span>A criar…</span>
                      </span>
                    ) : (
                      <span>Criar negócio</span>
                    )}
                  </button>
                </div>
              )}
              {g.erro && <div className="pd-grupo-erro">{g.erro}</div>}
            </div>
          ))}
          <div className="pd-outros-nota">O negócio novo herda o contacto deste e fica ligado à mesma simulação. Em alternativa, cria-o à mão no Pipedrive e cola lá o mesmo texto.</div>
        </div>
      )}

      {ignoradas.length > 0 && (
        <details className="pd-ignoradas">
          <summary>
            {ignoradas.length} linha{plural(ignoradas.length)} não comissionáve{ignoradas.length === 1 ? "l" : "is"} (sem duração ou sem multa mensal)
          </summary>
          <ul>
            {ignoradas.map((ig, i) => (
              <li key={i}>
                <span className="pd-ign-nome">{ig.nomeProduto}</span> — <span className="pd-ign-motivo">{ig.motivo}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {erro && <div className="pd-error">{erro}</div>}

      <div className="pd-actions">
        <button className="pd-btn pd-btn-secondary" onClick={editarTexto}>
          Editar texto
        </button>
        <button className="pd-btn pd-btn-secondary" disabled={aCarregarCatalogo} onClick={adicionarProduto}>
          ＋ Adicionar produto
        </button>
        <button className="pd-btn pd-btn-primary" disabled={!podeAplicar} onClick={aplicar}>
          Aplicar {linhas.length} produto{plural(linhas.length)}
        </button>
      </div>
    </section>
  );
}
