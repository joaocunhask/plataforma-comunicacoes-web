// O iframe do Custom Modal Action do Pipedrive (o mesmo path do .NET). Sem sessão da
// plataforma: a autenticação é o JWT do Pipedrive (?token=), validado em cada pedido à API.
import type { Metadata } from "next";
import { Suspense } from "react";
import "../modal.css";
import { ModalPreencherProdutos } from "./modal";

export const metadata: Metadata = { title: "Contrato — Preencher produtos" };

export default function Page() {
  return (
    <div className="pipedrive-modal-root">
      <header className="pd-header">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/bf-logo-black.png" alt="Brasfone" className="pd-header-logo" />
      </header>
      <main className="pd-main">
        <Suspense
          fallback={
            <section className="pd-block pd-center">
              <div className="pd-spinner" />
            </section>
          }
        >
          <ModalPreencherProdutos />
        </Suspense>
      </main>
    </div>
  );
}
