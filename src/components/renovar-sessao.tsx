"use client";

import { useEffect } from "react";
import { authCliente } from "@/lib/auth/cliente";

const INTERVALO_MS = 5 * 60 * 1000;

/**
 * Enquanto o utilizador está a usar a página, renova a sessão de 5 em 5 minutos — como o
 * refresh deslizante das apps .NET. As páginas do servidor não conseguem regravar o cookie;
 * este pedido ao /api/auth consegue. Sem atividade, a sessão acaba aos 30 minutos.
 */
export function RenovarSessao() {
  useEffect(() => {
    let ultimaAtividade = Date.now();
    const registar = () => {
      ultimaAtividade = Date.now();
    };
    const eventos = ["pointerdown", "keydown", "scroll"] as const;
    eventos.forEach((e) => window.addEventListener(e, registar, { passive: true }));

    const intervalo = window.setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - ultimaAtividade < INTERVALO_MS) {
        void authCliente.getSession();
      }
    }, INTERVALO_MS);

    return () => {
      window.clearInterval(intervalo);
      eventos.forEach((e) => window.removeEventListener(e, registar));
    };
  }, []);
  return null;
}
