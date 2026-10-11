import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import YAML from 'yaml';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SPEC_PATH = path.join(rootDir, 'spec', 'stekker-openapi-spec-v2.0.0.yaml');

const SPEC_ID = 'stekker-spec';

// Valideert HTTP-responses tegen de vastgepinde Stekker-OpenAPI-spec.
// Objectschema's worden gesloten (additionalProperties: false), zodat ook
// velden die niet in de spec staan als afwijking worden gemeld.
export function loadContract(specPath = SPEC_PATH) {
  const spec = YAML.parse(fs.readFileSync(specPath, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema({
    $id: SPEC_ID,
    components: { schemas: closeObjectSchemas(structuredClone(spec.components.schemas)) }
  });

  return {
    spec,
    successStatus(method, pathTemplate) {
      const operation = getOperation(spec, method, pathTemplate);
      const status = Object.keys(operation.responses).find((code) => code.startsWith('2'));
      return Number.parseInt(status, 10);
    },
    validateResponse({ method, pathTemplate, status, body }) {
      const operation = getOperation(spec, method, pathTemplate);
      let response = operation.responses[String(status)];

      if (!response) {
        return [`HTTP-status ${status} is niet gedocumenteerd voor ${method} ${pathTemplate} (wel: ${Object.keys(operation.responses).join(', ')})`];
      }

      if (response.$ref) {
        response = resolveLocalRef(spec, response.$ref);
      }

      const schema = response.content?.['application/json']?.schema;

      if (!schema) {
        return [];
      }

      const validate = ajv.compile(rewriteRefs(structuredClone(schema)));

      if (validate(body)) {
        return [];
      }

      return validate.errors.map(formatError);
    }
  };
}

function getOperation(spec, method, pathTemplate) {
  const operation = spec.paths[pathTemplate]?.[method.toLowerCase()];

  if (!operation) {
    throw new Error(`${method} ${pathTemplate} staat niet in de spec.`);
  }

  return operation;
}

function resolveLocalRef(spec, ref) {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((node, key) => node[key.replaceAll('~1', '/').replaceAll('~0', '~')], spec);
}

function rewriteRefs(node) {
  if (Array.isArray(node)) {
    return node.map(rewriteRefs);
  }

  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [
      key,
      key === '$ref' && typeof value === 'string' && value.startsWith('#/')
        ? `${SPEC_ID}${value}`
        : rewriteRefs(value)
    ]));
  }

  return node;
}

function closeObjectSchemas(node) {
  if (Array.isArray(node)) {
    return node.map(closeObjectSchemas);
  }

  if (node && typeof node === 'object') {
    const closed = Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, key === 'example' ? value : closeObjectSchemas(value)])
    );

    if (closed.properties && closed.additionalProperties === undefined) {
      closed.additionalProperties = false;
    }

    return closed;
  }

  return node;
}

function formatError(error) {
  const location = error.instancePath || '(root)';

  if (error.keyword === 'additionalProperties') {
    return `${location}: veld '${error.params.additionalProperty}' staat niet in de spec`;
  }

  return `${location}: ${error.message}`;
}
