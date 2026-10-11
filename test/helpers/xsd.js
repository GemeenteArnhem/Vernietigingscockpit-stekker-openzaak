import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const XSD_PAD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'spec', 'mdto', 'MDTO-XML1.0.1.xsd');

// Validatie tegen de officiële XSD van het Nationaal Archief, via Python + lxml.
// Ontbreekt dat op deze machine, dan wordt de controle overgeslagen (met melding).
export function valideerTegenXsd(t, xml) {
  const script = [
    'import sys',
    'from lxml import etree',
    'schema = etree.XMLSchema(etree.parse(sys.argv[1]))',
    'doc = etree.parse(sys.argv[2])',
    'ok = schema.validate(doc)',
    'print("\\n".join(str(e) for e in schema.error_log))',
    'sys.exit(0 if ok else 1)'
  ].join('\n');
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'mdto-'));
  const xmlPad = path.join(map, 'specificatie.xml');
  fs.writeFileSync(xmlPad, xml);

  for (const python of ['python3', 'python']) {
    const resultaat = spawnSync(python, ['-c', script, XSD_PAD, xmlPad], { encoding: 'utf8' });

    if (resultaat.error || /No module named/.test(resultaat.stderr ?? '')) {
      continue;
    }

    fs.rmSync(map, { recursive: true, force: true });
    assert.equal(resultaat.status, 0, `MDTO-XML voldoet niet aan de XSD:\n${resultaat.stdout}${resultaat.stderr}`);
    return;
  }

  fs.rmSync(map, { recursive: true, force: true });
  t.diagnostic('XSD-validatie overgeslagen: geen Python met lxml gevonden.');
}
