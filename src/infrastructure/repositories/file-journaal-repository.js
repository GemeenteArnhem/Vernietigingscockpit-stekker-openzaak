import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Journaal per vernietiging en kandidaat: één JSON-regel per uitgevoerde stap in de bron
// (append-only, met datasync). Vervangt OAB's ResourceDestructionResult en maakt hervatten
// na een fout of crash veilig: de bron leest het journaal en slaat afgeronde stappen over.
export class FileJournaalRepository {
  constructor(basisPad) {
    this.basisPad = basisPad;
  }

  voor(vernietigingId, vernietigingskandidaatId) {
    // Het kandidaat-id komt van buiten; gehasht kan het nooit buiten de map wijzen.
    const bestand = path.join(
      this.basisPad,
      veiligeNaam(vernietigingId),
      `${crypto.createHash('sha256').update(vernietigingskandidaatId).digest('hex').slice(0, 32)}.jsonl`
    );

    return {
      lees: () => leesRegels(bestand),
      schrijf: (regel) => schrijfRegel(bestand, regel)
    };
  }
}

async function leesRegels(bestand) {
  let tekst;

  try {
    tekst = await fs.readFile(bestand, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const regels = [];

  for (const regel of tekst.split('\n')) {
    if (!regel.trim()) {
      continue;
    }

    try {
      regels.push(JSON.parse(regel));
    } catch {
      // Een half geschreven laatste regel na een crash telt niet mee.
    }
  }

  return regels;
}

async function schrijfRegel(bestand, regel) {
  await fs.mkdir(path.dirname(bestand), { recursive: true });
  const handle = await fs.open(bestand, 'a+');

  try {
    const { size } = await handle.stat();
    let voorvoegsel = '';

    // Eindigt het journaal op een half geschreven regel (crash), begin dan op een nieuwe regel.
    if (size > 0) {
      const laatste = Buffer.alloc(1);
      await handle.read(laatste, 0, 1, size - 1);
      voorvoegsel = laatste.toString() === '\n' ? '' : '\n';
    }

    await handle.appendFile(`${voorvoegsel}${JSON.stringify(regel)}\n`, 'utf8');
    await handle.datasync();
  } finally {
    await handle.close();
  }
}

function veiligeNaam(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(id) || id === '.' || id === '..') {
    throw new Error(`Ongeldig id voor journaal: ${JSON.stringify(id)}`);
  }

  return id;
}
