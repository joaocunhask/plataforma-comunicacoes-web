// Equivalentes do LINQ cujo comportamento o motor C# usa e que mudam resultados.

/** GroupBy: grupos pela ordem da primeira ocorrência. */
export function agrupar<T, K, V>(itens: Iterable<T>, chave: (item: T) => K, valor: (item: T) => V): Map<K, V[]> {
  const grupos = new Map<K, V[]>();
  for (const item of itens) {
    const k = chave(item);
    const grupo = grupos.get(k);
    if (grupo) grupo.push(valor(item));
    else grupos.set(k, [valor(item)]);
  }
  return grupos;
}

/** ToDictionary: lança em chave duplicada, como o C#. */
export function mapaUnico<T, K, V>(itens: Iterable<T>, chave: (item: T) => K, valor: (item: T) => V): Map<K, V> {
  const mapa = new Map<K, V>();
  for (const item of itens) {
    const k = chave(item);
    if (mapa.has(k)) throw new Error(`Chave duplicada: ${String(k)}.`);
    mapa.set(k, valor(item));
  }
  return mapa;
}
