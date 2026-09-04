import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  mkdir,
  link,
  open,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import type { ArtifactKeyringConfig } from "./config.js";

const magic = Buffer.from("ADK1", "ascii");

export interface StoredArtifact {
  storageKey: string;
  encryptionKeyId: string;
  contentHash: string;
  created: boolean;
}

export interface ArtifactDescriptor {
  storageKey: string;
  encryptionKeyId: string;
  contentHash: string;
  tenantId: string;
  artifactId: string;
  mediaType: string;
}

export class EncryptedArtifactStore {
  private readonly root: string;

  public constructor(
    directory: string,
    private readonly keyring: ArtifactKeyringConfig,
  ) {
    this.root = resolve(directory);
  }

  public async put(
    tenantId: string,
    artifactId: string,
    mediaType: string,
    content: string,
  ): Promise<StoredArtifact> {
    const contentBuffer = Buffer.from(content, "utf8");
    const contentHash = createHash("sha256").update(contentBuffer).digest("hex");
    const storageKey = storageKeyFor(tenantId, artifactId);
    const path = this.pathFor(storageKey);
    const descriptor: ArtifactDescriptor = {
      tenantId,
      artifactId,
      mediaType,
      contentHash,
      storageKey,
      encryptionKeyId: this.keyring.currentKeyId,
    };

    if (await exists(path)) {
      const existingDescriptor = {
        ...descriptor,
        encryptionKeyId: await readKeyId(path),
      };
      const existing = await this.get(existingDescriptor);
      if (existing !== content) {
        throw new Error(`Artifact ${artifactId} is immutable`);
      }
      return { ...existingDescriptor, created: false };
    }

    const encrypted = encrypt(
      contentBuffer,
      descriptor,
      this.keyring.keys.get(this.keyring.currentKeyId),
    );
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(encrypted);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
      await rm(temporary, { force: true });
      await syncDirectory(dirname(path));
      return { ...descriptor, created: true };
    } catch (error) {
      await rm(temporary, { force: true });
      if (isAlreadyExists(error)) {
        const existingDescriptor = {
          ...descriptor,
          encryptionKeyId: await readKeyId(path),
        };
        const existing = await this.get(existingDescriptor);
        if (existing !== content) {
          throw new Error(`Artifact ${artifactId} is immutable`);
        }
        return { ...existingDescriptor, created: false };
      }
      throw error;
    }
  }

  public async get(descriptor: ArtifactDescriptor): Promise<string> {
    const path = this.pathFor(descriptor.storageKey);
    const encrypted = await readFile(path);
    const plaintext = decrypt(encrypted, descriptor, this.keyring.keys);
    const contentHash = createHash("sha256").update(plaintext).digest("hex");
    if (contentHash !== descriptor.contentHash) {
      throw new Error("Artifact integrity check failed");
    }
    return plaintext.toString("utf8");
  }

  public async delete(storageKey: string): Promise<string> {
    const path = this.pathFor(storageKey);
    const encrypted = await readFile(path);
    const proof = createHash("sha256").update(encrypted).digest("hex");
    await rm(path, { force: true });
    await syncDirectory(dirname(path));
    return proof;
  }

  public async removeIfPresent(storageKey: string): Promise<void> {
    const path = this.pathFor(storageKey);
    await rm(path, { force: true });
    await syncDirectory(dirname(path));
  }

  public async listStoredFiles(): Promise<
    Array<{ storageKey: string; modifiedAt: Date }>
  > {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root, {
      recursive: true,
      withFileTypes: true,
    });
    const files: Array<{ storageKey: string; modifiedAt: Date }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const fullPath = join(entry.parentPath, entry.name);
      const metadata = await stat(fullPath);
      files.push({
        storageKey: relative(this.root, fullPath).replaceAll("\\", "/"),
        modifiedAt: metadata.mtime,
      });
    }
    return files;
  }

  private pathFor(storageKey: string): string {
    if (
      storageKey.includes("\\") ||
      storageKey.split("/").some((part) => part === ".." || part === "")
    ) {
      throw new Error("Artifact storage key is invalid");
    }
    const path = resolve(this.root, ...storageKey.split("/"));
    if (!path.startsWith(`${this.root}\\`) && !path.startsWith(`${this.root}/`)) {
      throw new Error("Artifact storage path escaped its root");
    }
    return path;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (platform() === "win32") {
    return;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function encrypt(
  plaintext: Buffer,
  descriptor: ArtifactDescriptor,
  masterKey: Buffer | undefined,
): Buffer {
  if (!masterKey) {
    throw new Error(`Encryption key ${descriptor.encryptionKeyId} was not found`);
  }
  const nonce = randomBytes(12);
  const key = deriveTenantKey(masterKey, descriptor.tenantId);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(descriptor));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const keyId = Buffer.from(descriptor.encryptionKeyId, "utf8");
  if (keyId.length > 255) {
    throw new Error("Encryption key ID is too long");
  }
  return Buffer.concat([
    magic,
    Buffer.from([keyId.length]),
    keyId,
    nonce,
    tag,
    ciphertext,
  ]);
}

function decrypt(
  encrypted: Buffer,
  descriptor: ArtifactDescriptor,
  keys: Map<string, Buffer>,
): Buffer {
  if (encrypted.subarray(0, magic.length).compare(magic) !== 0) {
    throw new Error("Unsupported encrypted artifact format");
  }
  const keyIdLength = encrypted[magic.length];
  if (keyIdLength === undefined) {
    throw new Error("Encrypted artifact header is truncated");
  }
  const keyIdStart = magic.length + 1;
  const keyIdEnd = keyIdStart + keyIdLength;
  const keyId = encrypted.subarray(keyIdStart, keyIdEnd).toString("utf8");
  if (keyId !== descriptor.encryptionKeyId) {
    throw new Error("Artifact encryption key metadata does not match the file");
  }
  const nonceStart = keyIdEnd;
  const tagStart = nonceStart + 12;
  const ciphertextStart = tagStart + 16;
  if (encrypted.length < ciphertextStart) {
    throw new Error("Encrypted artifact is truncated");
  }
  const masterKey = keys.get(keyId);
  if (!masterKey) {
    throw new Error(`Encryption key ${keyId} is unavailable`);
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveTenantKey(masterKey, descriptor.tenantId),
    encrypted.subarray(nonceStart, tagStart),
  );
  decipher.setAAD(aad(descriptor));
  decipher.setAuthTag(encrypted.subarray(tagStart, ciphertextStart));
  return Buffer.concat([
    decipher.update(encrypted.subarray(ciphertextStart)),
    decipher.final(),
  ]);
}

function deriveTenantKey(masterKey: Buffer, tenantId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      Buffer.from(tenantId, "utf8"),
      Buffer.from("agentic-data-artifact-v1", "utf8"),
      32,
    ),
  );
}

function aad(descriptor: ArtifactDescriptor): Buffer {
  return Buffer.from(
    [
      descriptor.tenantId,
      descriptor.artifactId,
      descriptor.mediaType,
      descriptor.contentHash,
    ].join("\u0000"),
    "utf8",
  );
}

function storageKeyFor(tenantId: string, artifactId: string): string {
  const tenantHash = createHash("sha256").update(tenantId).digest("hex");
  const artifactHash = createHash("sha256").update(artifactId).digest("hex");
  return posix.join(
    tenantHash.slice(0, 2),
    tenantHash,
    `${artifactHash}.bin`,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function readKeyId(path: string): Promise<string> {
  const encrypted = await readFile(path);
  if (encrypted.subarray(0, magic.length).compare(magic) !== 0) {
    throw new Error("Unsupported encrypted artifact format");
  }
  const keyIdLength = encrypted[magic.length];
  if (keyIdLength === undefined) {
    throw new Error("Encrypted artifact header is truncated");
  }
  return encrypted
    .subarray(magic.length + 1, magic.length + 1 + keyIdLength)
    .toString("utf8");
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
