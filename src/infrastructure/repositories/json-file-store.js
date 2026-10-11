import fs from 'node:fs';
import path from 'node:path';

// Id's komen deels uit de URL; alleen veilige tekens worden een bestandsnaam,
// zodat een id nooit buiten de opslagmap kan wijzen.
const VEILIG_ID = /^[A-Za-z0-9_-]{1,200}$/;

// Eén JSON-bestand per entiteit. Schrijven gaat via een tijdelijk bestand en een
// rename, zodat een crash nooit een half geschreven bestand achterlaat.
export class JsonFileStore {
  constructor(directory, bestandsnaam = (id) => `${id}.json`) {
    this.directory = directory;
    this.bestandsnaam = bestandsnaam;
    fs.mkdirSync(directory, { recursive: true });
  }

  save(id, waarde) {
    const bestand = this.pad(id);

    if (!bestand) {
      throw new Error(`Ongeldig id voor opslag: ${id}`);
    }

    fs.mkdirSync(path.dirname(bestand), { recursive: true });
    const tijdelijk = `${bestand}.${process.pid}.tmp`;
    fs.writeFileSync(tijdelijk, JSON.stringify(waarde), 'utf8');
    fs.renameSync(tijdelijk, bestand);
    return waarde;
  }

  findById(id) {
    const bestand = this.pad(id);

    if (!bestand || !fs.existsSync(bestand)) {
      return undefined;
    }

    return JSON.parse(fs.readFileSync(bestand, 'utf8'));
  }

  findAll() {
    // Werkt voor zowel `<id>.json` als `<id>/<bestand>.json`; tijdelijke bestanden vallen af.
    return fs.readdirSync(this.directory)
      .map((naam) => naam.replace(/\.json$/, ''))
      .filter((id) => VEILIG_ID.test(id))
      .map((id) => this.findById(id))
      .filter(Boolean);
  }

  pad(id) {
    return typeof id === 'string' && VEILIG_ID.test(id) ? path.join(this.directory, this.bestandsnaam(id)) : undefined;
  }
}
