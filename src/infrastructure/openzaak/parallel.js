// Voert `werk` uit voor elk item, met hooguit `limiet` tegelijk. De uitkomsten staan in
// dezelfde volgorde als de items. Bij de eerste fout stopt het starten van nieuw werk en
// wordt die fout doorgegeven (lopend werk mag nog afronden).
export async function metBeperking(items, limiet, werk) {
  const uitkomsten = new Array(items.length);
  let volgende = 0;
  let fout;

  async function werker() {
    while (fout === undefined && volgende < items.length) {
      const index = volgende;
      volgende += 1;

      try {
        uitkomsten[index] = await werk(items[index], index);
      } catch (error) {
        fout ??= error;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(Math.max(1, limiet), items.length) }, werker));

  if (fout !== undefined) {
    throw fout;
  }

  return uitkomsten;
}
