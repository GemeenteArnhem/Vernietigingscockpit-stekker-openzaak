export class InMemoryVernietigingRepository {
  #vernietigingen = new Map();

  save(vernietiging) {
    this.#vernietigingen.set(vernietiging.vernietigingId, structuredClone(vernietiging));
    return vernietiging;
  }

  findById(vernietigingId) {
    const vernietiging = this.#vernietigingen.get(vernietigingId);
    return vernietiging ? structuredClone(vernietiging) : undefined;
  }

  findAll() {
    return [...this.#vernietigingen.values()].map((waarde) => structuredClone(waarde));
  }
}
