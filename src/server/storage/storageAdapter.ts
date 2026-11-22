import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { and, isNull, lte, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { storedFiles } from '../../db/schema.ts';
import { getR2Config, isCloudflareWorker } from '../config/env.ts';
import {
  getCloudflareRequestContext,
  type CloudflareBlobStore,
} from '../cloudflare/requestContext.ts';
import type { CloudflareR2Bucket } from '../../cloudflare-env.d.ts';

export type { CloudflareBlobStore };

declare global {
  var _hooshnegarCfR2Bucket: CloudflareR2Bucket | undefined;
  var _hooshnegarCfBlobStore: CloudflareBlobStore | undefined;
}

export function setCloudflareR2Bucket(bucket: CloudflareR2Bucket | undefined): void {
  global._hooshnegarCfR2Bucket = bucket;
}

export function setCloudflareBlobStore(store: CloudflareBlobStore | undefined): void {
  global._hooshnegarCfBlobStore = store;
}

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

export interface StorageObjectData {
  buffer: Buffer;
  mimeType: string;
}

export interface StorageAdapter {
  readonly providerName: 'r2' | 'local_temp';
  putObject(input: StoragePutInput): Promise<StoredObjectResult>;
  getObject(objectKey: string): Promise<StorageObjectData | null>;
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

  async getObject(objectKey: string): Promise<StorageObjectData | null> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: objectKey,
        }),
      );
      if (!out.Body) return null;
      const bytes = await out.Body.transformToByteArray();
      return {
        buffer: Buffer.from(bytes),
        mimeType: out.ContentType ?? 'application/octet-stream',
      };
    } catch {
      return null;
    }
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

class CloudflareNativeR2BindingAdapter implements StorageAdapter {
  readonly providerName = 'r2' as const;

  constructor(
    private readonly bucket: CloudflareR2Bucket,
    private readonly publicBaseUrl: string,
  ) {}

  async putObject(input: StoragePutInput): Promise<StoredObjectResult> {
    const objectKey = buildObjectKey(input.prefix, input.extension);
    const ttlHours = input.ttlHours ?? (input.prefix === 'temp-uploads' ? 2 : 72);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    await this.bucket.put(objectKey, input.buffer, {
      httpMetadata: { contentType: input.mimeType },
      customMetadata: { expiresAt: expiresAt.toISOString() },
    });

    const signedUrl = await this.getSignedDownloadUrl(objectKey);
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

  async getObject(objectKey: string): Promise<StorageObjectData | null> {
    const obj = await this.bucket.get(objectKey);
    if (!obj) return null;
    const buf = Buffer.from(await obj.arrayBuffer());
    return {
      buffer: buf,
      mimeType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
    };
  }

  async getSignedDownloadUrl(objectKey: string): Promise<string | null> {
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/+$/, '')}/${objectKey}`;
    }
    return null;
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.bucket.delete(objectKey);
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

class CloudflareDurableObjectBlobAdapter implements StorageAdapter {
  readonly providerName = 'local_temp' as const;

  private getStore(): CloudflareBlobStore {
    const store = getCloudflareRequestContext()?.blobStore ?? global._hooshnegarCfBlobStore;
    if (!store) {
      throw new Error('Cloudflare Durable Object STATE_DB blob store is not available for this request.');
    }
    return store;
  }

  async putObject(input: StoragePutInput): Promise<StoredObjectResult> {
    const objectKey = buildObjectKey(input.prefix, input.extension);
    const ttlHours = input.ttlHours ?? (input.prefix === 'temp-uploads' ? 2 : 72);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    await this.getStore().putBlob(
      objectKey,
      input.mimeType,
      input.buffer.toString('base64'),
      expiresAt.toISOString(),
    );

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
      localPath: null,
      expiresAt,
    };
  }

  async getObject(objectKey: string): Promise<StorageObjectData | null> {
    const blob = await this.getStore().getBlob(objectKey);
    if (!blob) return null;
    return {
      buffer: Buffer.from(blob.dataBase64, 'base64'),
      mimeType: blob.mimeType,
    };
  }

  async getSignedDownloadUrl(_objectKey: string): Promise<string | null> {
    return null;
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.getStore().deleteBlob(objectKey);
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
        // Ignore cleanup errors
      }
    }
    return cleaned;
  }
}

class LocalTempStorageAdapter implements StorageAdapter {
  readonly providerName = 'local_temp' as const;

  async putObject(input: StoragePutInput): Promise<StoredObjectResult> {
    if (isCloudflareWorker()) {
      throw new Error(
        'Cloudflare R2 or STATE_DB Durable Object storage is required on Cloudflare Workers.',
      );
    }
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

  async getObject(objectKey: string): Promise<StorageObjectData | null> {
    const safeRel = path.normalize(objectKey).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.join(LOCAL_TEMP_DIR, safeRel);
    try {
      const buffer = await fs.readFile(fullPath);
      const ext = path.extname(fullPath).toLowerCase();
      const mimeType =
        ext === '.png'
          ? 'image/png'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.jpg' || ext === '.jpeg'
              ? 'image/jpeg'
              : ext === '.mp3'
                ? 'audio/mpeg'
                : ext === '.ogg'
                  ? 'audio/ogg'
                  : ext === '.wav'
                    ? 'audio/wav'
                    : ext === '.mp4'
                      ? 'video/mp4'
                      : 'application/octet-stream';
      return { buffer, mimeType };
    } catch {
      return null;
    }
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
  const activeR2Bucket = getCloudflareRequestContext()?.r2Bucket ?? global._hooshnegarCfR2Bucket;
  if (activeR2Bucket) {
    return new CloudflareNativeR2BindingAdapter(activeR2Bucket, r2.publicBaseUrl);
  }
  if (r2.configured) {
    if (!cachedAdapter || cachedAdapter.providerName !== 'r2') {
      cachedAdapter = new CloudflareR2StorageAdapter();
    }
    return cachedAdapter;
  }
  if (getCloudflareRequestContext()?.blobStore ?? global._hooshnegarCfBlobStore) {
    return new CloudflareDurableObjectBlobAdapter();
  }
  if (!cachedAdapter || cachedAdapter.providerName !== 'local_temp') {
    cachedAdapter = new LocalTempStorageAdapter();
  }
  return cachedAdapter;
}
