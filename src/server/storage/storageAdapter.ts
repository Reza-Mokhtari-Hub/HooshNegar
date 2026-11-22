import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { and, isNull, lte, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { storedFiles } from '../../db/schema.ts';
import { getR2Config } from '../config/env.ts';

export interface StoredObjectResult {
  id: string;
  storageProvider: 'r2' | 'local_temp';
  objectKey: string;
  mimeType: string;
  fileSizeBytes: number;
  signedUrl: string | null;
  localPath: string | null;
  expiresAt: Date;
}

export interface StoragePutInput {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  prefix: 'generated-images' | 'generated-videos' | 'generated-audio' | 'temp-uploads';
  userId?: string | null;
  requestId?: string | null;
  jobId?: string | null;
  ttlHours?: number;
}

export interface StorageAdapter {
  readonly providerName: 'r2' | 'local_temp';
  putObject(input: StoragePutInput): Promise<StoredObjectResult>;
  getSignedDownloadUrl(objectKey: string, expiresInSeconds?: number): Promise<string | null>;
  deleteObject(objectKey: string): Promise<void>;
  cleanupExpiredFiles(): Promise<number>;
}

const LOCAL_TEMP_DIR = path.resolve(process.cwd(), 'data', 'temp-files');

function buildObjectKey(prefix: string, extension: string): string {
  const datePart = new Date().toISOString().slice(0, 10);
  const rand = crypto.randomBytes(12).toString('hex');
  const cleanExt = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  return `${prefix}/${datePart}/${rand}.${cleanExt}`;
}

class CloudflareR2StorageAdapter implements StorageAdapter {
  readonly providerName = 'r2' as const;
  private readonly client: S3Client;
  private readonly bucketName: string;
  private readonly publicBaseUrl: string;

  constructor() {
    const cfg = getR2Config();
    this.bucketName = cfg.bucketName;
    this.publicBaseUrl = cfg.publicBaseUrl.replace(/\/+$/, '');
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }

  async putObject(input: StoragePutInput): Promise<StoredObjectResult> {
    const objectKey = buildObjectKey(input.prefix, input.extension);
    const ttlHours = input.ttlHours ?? (input.prefix === 'temp-uploads' ? 2 : 72);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
        Body: input.buffer,
        ContentType: input.mimeType,
        Metadata: {
          expiresAt: expiresAt.toISOString(),
        },
      }),
    );

    const signedUrl = await this.getSignedDownloadUrl(objectKey, 3600);
    const db = getDb();
    const [row] = await db
      .insert(storedFiles)
      .values({
        userId: input.userId ?? null,
        requestId: input.requestId ?? null,
        jobId: input.jobId ?? null,
        storageProvider: 'r2',
        objectKey,
        mimeType: input.mimeType,
        fileSizeBytes: input.buffer.byteLength,
        expiresAt,
      })
      .returning({ id: storedFiles.id });

    return {
      id: row?.id ?? objectKey,
      storageProvider: 'r2',
      objectKey,
      mimeType: input.mimeType,
      fileSizeBytes: input.buffer.byteLength,
      signedUrl,
      localPath: null,
      expiresAt,
    };
  }

  async getSignedDownloadUrl(objectKey: string, expiresInSeconds = 3600): Promise<string | null> {
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl}/${objectKey}`;
    }
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
      }),
    );
  }

  async cleanupExpiredFiles(): Promise<number> {
    const db = getDb();
    const now = new Date();
    const expired = await db
      .select()
      .from(storedFiles)
      .where(and(eq(storedFiles.storageProvider, 'r2'), isNull(storedFiles.deletedAt), lte(storedFiles.expiresAt, now)))
      .limit(100);

    let cleaned = 0;
    for (const file of expired) {
      try {
        await this.deleteObject(file.objectKey);
        await db
          .update(storedFiles)
          .set({ deletedAt: now })
          .where(eq(storedFiles.id, file.id));
        cleaned += 1;
      } catch {
        // Continue cleaning other objects
      }
    }
    return cleaned;
  }
}

class LocalTempStorageAdapter implements StorageAdapter {
  readonly providerName = 'local_temp' as const;

  async putObject(input: StoragePutInput): Promise<StoredObjectResult> {
    const objectKey = buildObjectKey(input.prefix, input.extension);
    const fullPath = path.join(LOCAL_TEMP_DIR, objectKey);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, input.buffer);

    const ttlHours = input.ttlHours ?? (input.prefix === 'temp-uploads' ? 1 : 24);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    const db = getDb();
    const [row] = await db
      .insert(storedFiles)
      .values({
        userId: input.userId ?? null,
        requestId: input.requestId ?? null,
        jobId: input.jobId ?? null,
        storageProvider: 'local_temp',
        objectKey,
        mimeType: input.mimeType,
        fileSizeBytes: input.buffer.byteLength,
        expiresAt,
      })
      .returning({ id: storedFiles.id });

    return {
      id: row?.id ?? objectKey,
      storageProvider: 'local_temp',
      objectKey,
      mimeType: input.mimeType,
      fileSizeBytes: input.buffer.byteLength,
      signedUrl: null,
      localPath: fullPath,
      expiresAt,
    };
  }

  async getSignedDownloadUrl(_objectKey: string): Promise<string | null> {
    return null;
  }

  async deleteObject(objectKey: string): Promise<void> {
    const fullPath = path.join(LOCAL_TEMP_DIR, objectKey);
    await fs.rm(fullPath, { force: true });
  }

  async cleanupExpiredFiles(): Promise<number> {
    const db = getDb();
    const now = new Date();
    const expired = await db
      .select()
      .from(storedFiles)
      .where(
        and(eq(storedFiles.storageProvider, 'local_temp'), isNull(storedFiles.deletedAt), lte(storedFiles.expiresAt, now)),
      )
      .limit(100);

    let cleaned = 0;
    for (const file of expired) {
      try {
        await this.deleteObject(file.objectKey);
        await db
          .update(storedFiles)
          .set({ deletedAt: now })
          .where(eq(storedFiles.id, file.id));
        cleaned += 1;
      } catch {
        // Ignore missing temp files
      }
    }
    return cleaned;
  }
}

let cachedAdapter: StorageAdapter | null = null;

export function getStorageAdapter(): StorageAdapter {
  const r2 = getR2Config();
  if (r2.configured) {
    if (!cachedAdapter || cachedAdapter.providerName !== 'r2') {
      cachedAdapter = new CloudflareR2StorageAdapter();
    }
    return cachedAdapter;
  }
  if (!cachedAdapter || cachedAdapter.providerName !== 'local_temp') {
    cachedAdapter = new LocalTempStorageAdapter();
  }
  return cachedAdapter;
}
