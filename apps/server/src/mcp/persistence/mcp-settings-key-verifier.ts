import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseService } from '../../db/database.service';
import { decryptValue, encryptValue, isEncrypted } from '../../settings/settings.crypto';

const VERIFIER_FILE = 'mcp-settings-key.verifier';
const VERIFIER_PLAINTEXT = 'nuncio:mcp-settings-key:v1';

export interface McpKeyEvidence {
  ciphertexts: string[];
  hasUnverifiablePlaintextSecrets: boolean;
}

/**
 * Proves that the active key belongs to this installation before a legacy
 * plaintext credential is rewritten in place. A persisted verifier is the
 * primary proof; the installation key file or authenticated ciphertext can
 * bootstrap it for upgrades. With no historical key-bearing data, the active
 * key becomes the first-install baseline.
 */
export function establishMcpSettingsKeyTrust(
  database: DatabaseService,
  key: Buffer,
  evidence: McpKeyEvidence,
): boolean {
  const verifierPath = join(database.dataDir, VERIFIER_FILE);
  const verifierExists = existsSync(verifierPath);
  if (verifierExists && decryptsToVerifier(readFileSync(verifierPath, 'utf8'), key)) {
    return true;
  }

  const sharedCiphertexts = readSharedCiphertexts(database);
  const ciphertexts = [...evidence.ciphertexts, ...sharedCiphertexts.values];
  const authenticatedByCiphertext = ciphertexts.some((value) => decrypts(value, key));
  const keyFilePath = join(database.dataDir, 'settings.key');
  const keyFileExists = existsSync(keyFilePath);
  const authenticatedByKeyFile = keyFileExists && readFileSync(keyFilePath).equals(key);

  if (authenticatedByCiphertext || authenticatedByKeyFile) {
    persistVerifier(verifierPath, key);
    return true;
  }

  const historicalKeyEvidenceExists =
    verifierExists ||
    keyFileExists ||
    ciphertexts.length > 0 ||
    sharedCiphertexts.hasPlaintextSecrets ||
    evidence.hasUnverifiablePlaintextSecrets;
  if (historicalKeyEvidenceExists) return false;

  persistVerifier(verifierPath, key);
  return true;
}

function readSharedCiphertexts(database: DatabaseService): {
  values: string[];
  hasPlaintextSecrets: boolean;
} {
  const values: string[] = [];
  let hasPlaintextSecrets = false;
  try {
    const settings = database.db
      .prepare<{ value: string }, []>("SELECT value FROM settings WHERE value LIKE 'v1:%'")
      .all();
    values.push(...settings.map((row) => row.value));
  } catch {
    // An older partial schema supplies no shared key evidence.
  }

  try {
    const rows = database.db
      .prepare<
        { tokens_json: string | null; client_info_json: string | null; code_verifier: string | null },
        []
      >('SELECT tokens_json, client_info_json, code_verifier FROM mcp_oauth')
      .all();
    for (const row of rows) {
      for (const value of [row.tokens_json, row.client_info_json, row.code_verifier]) {
        if (!value) continue;
        if (isEncrypted(value)) values.push(value);
        else hasPlaintextSecrets = true;
      }
    }
  } catch {
    // OAuth storage predating the table supplies no shared key evidence.
  }

  return { values, hasPlaintextSecrets };
}

function decryptsToVerifier(stored: string, key: Buffer): boolean {
  try {
    return decryptValue(stored, key) === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}

function decrypts(stored: string, key: Buffer): boolean {
  if (!isEncrypted(stored)) return false;
  try {
    decryptValue(stored, key);
    return true;
  } catch {
    return false;
  }
}

function persistVerifier(path: string, key: Buffer): void {
  writeFileSync(path, encryptValue(VERIFIER_PLAINTEXT, key), { mode: 0o600 });
}
