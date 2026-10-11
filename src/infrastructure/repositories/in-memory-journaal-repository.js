export class InMemoryJournaalRepository {
  constructor() {
    this.journalen = new Map();
  }

  voor(vernietigingId, vernietigingskandidaatId) {
    const sleutel = `${vernietigingId}\u0000${vernietigingskandidaatId}`;

    if (!this.journalen.has(sleutel)) {
      this.journalen.set(sleutel, []);
    }

    const regels = this.journalen.get(sleutel);

    return {
      lees: async () => regels.map((regel) => structuredClone(regel)),
      schrijf: async (regel) => {
        regels.push(structuredClone(regel));
      }
    };
  }
}
