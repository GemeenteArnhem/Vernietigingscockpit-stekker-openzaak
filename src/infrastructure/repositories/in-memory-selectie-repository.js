export class InMemorySelectieRepository {
  #selecties = new Map();

  save(selectie) {
    this.#selecties.set(selectie.selectieId, structuredClone(selectie));
    return selectie;
  }

  findById(selectieId) {
    const selectie = this.#selecties.get(selectieId);
    return selectie ? structuredClone(selectie) : undefined;
  }

  findAll() {
    return [...this.#selecties.values()].map((waarde) => structuredClone(waarde));
  }
}
