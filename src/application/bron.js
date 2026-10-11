// De bron (poort) waarop de stekker selecteert en vernietigt. De services kennen alleen
// deze vorm; de OpenZaak-adapter (src/infrastructure/openzaak) is de echte implementatie,
// test/helpers/geheugen-bron.js een implementatie in het geheugen voor tests.
//
// selecteer({ peildatum, leverNietV })
//   -> { bronRecords, kandidaten, waarschuwingen }
//   Elke kandidaat is een MDTO-kandidaat volgens Stekker API v2, plus interne velden:
//   - bronId: technische sleutel; moet gelijk zijn aan het identificatieKenmerk met
//     identificatieBron = mdto.technischeBron (vangnet bij uitvoering);
//   - onderdelen: de direct onderliggende objecten als MDTO-verwijzingen (momentopname,
//     ADR-0007 DR-04), gebruikt voor de specificatie;
//   - momentopname: wat de bron verder nodig heeft om bij uitvoering te controleren en
//     te vernietigen (opaak voor de services).
//
// controleer(kandidaat)
//   -> undefined als de kandidaat nog precies zo in de bron staat als bij selectie, anders
//      { resultaat: 'NOT_FOUND' | 'CHANGED' | 'SKIPPED', foutcode, foutmelding, bronstatus }.
//   Wordt alleen aangeroepen als er voor deze kandidaat nog niets is vernietigd.
//
// vernietig(kandidaat, { journaal, clock })
//   -> { eventTijd, onderdeelUitkomsten: [{ identificatieKenmerk, uitkomst: 'vernietigd' | 'ontkoppeld' }] }
//   Legt elke stap vast in het journaal (zie journaal-repository) vóór de volgende stap,
//   zodat een herhaalde aanroep na een fout of crash verdergaat waar de vorige stopte.
//   Een journaalregel met `wijziging: true` betekent dat er in de bron iets is veranderd; een
//   regel met `identificatieKenmerk` en `uitkomst` is de uitkomst voor een onderdeel.
//   Gooit een fout als een stap mislukt; de service probeert het dan opnieuw.

// volgorde(kandidaten) (optioneel)
//   -> dezelfde kandidaten in de volgorde waarin ze binnen een batch verwerkt moeten worden.

const METHODEN = ['selecteer', 'controleer', 'vernietig'];

export function controleerBron(bron) {
  const ontbrekend = METHODEN.filter((methode) => typeof bron?.[methode] !== 'function');

  if (ontbrekend.length > 0) {
    throw new Error(`Bron mist ${ontbrekend.join(', ')}.`);
  }

  return bron;
}
