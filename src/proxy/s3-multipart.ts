import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID, createHash } from "crypto";

interface MultipartUpload {
  bucket: string;
  key: string;
  uploadId: string;
  stagingDir: string;
}

export class MultipartManager {
  private baseDir: string;
  private uploads = new Map<string, MultipartUpload>();

  constructor(stagingDir: string) {
    this.baseDir = stagingDir;
    mkdirSync(stagingDir, { recursive: true });
  }

  initiate(bucket: string, key: string): string {
    const uploadId = randomUUID();
    const stagingDir = join(this.baseDir, uploadId);
    mkdirSync(stagingDir, { recursive: true });
    this.uploads.set(uploadId, { bucket, key, uploadId, stagingDir });
    return uploadId;
  }

  async uploadPart(
    uploadId: string,
    partNumber: number,
    data: Buffer,
  ): Promise<string> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error(`Unknown upload ID: ${uploadId}`);

    const partPath = join(
      upload.stagingDir,
      String(partNumber).padStart(5, "0"),
    );
    await Bun.write(partPath, data);

    const etag = `"${createHash("md5").update(data).digest("hex")}"`;
    return etag;
  }

  async complete(uploadId: string, partNumbers: number[]): Promise<Buffer> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error(`Unknown upload ID: ${uploadId}`);

    // Read parts in order
    const chunks: Buffer[] = [];
    for (const partNum of partNumbers.sort((a, b) => a - b)) {
      const partPath = join(
        upload.stagingDir,
        String(partNum).padStart(5, "0"),
      );
      if (!existsSync(partPath)) throw new Error(`Missing part ${partNum}`);
      chunks.push(Buffer.from(await Bun.file(partPath).arrayBuffer()));
    }

    const assembled = Buffer.concat(chunks);

    // Cleanup staging
    rmSync(upload.stagingDir, { recursive: true, force: true });
    this.uploads.delete(uploadId);

    return assembled;
  }

  abort(uploadId: string): void {
    const upload = this.uploads.get(uploadId);
    if (!upload) return;
    rmSync(upload.stagingDir, { recursive: true, force: true });
    this.uploads.delete(uploadId);
  }

  getUpload(uploadId: string): MultipartUpload | undefined {
    return this.uploads.get(uploadId);
  }
}
