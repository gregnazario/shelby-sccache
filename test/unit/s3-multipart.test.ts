import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MultipartManager } from "../../src/proxy/s3-multipart";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("MultipartManager", () => {
  let tmpDir: string;
  let manager: MultipartManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "multipart-test-"));
    manager = new MultipartManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it("creates an upload and returns an ID", () => {
    const uploadId = manager.initiate("bucket", "key1");
    expect(uploadId).toBeTruthy();
    expect(typeof uploadId).toBe("string");
  });

  it("stores and assembles parts in order", async () => {
    const uploadId = manager.initiate("bucket", "key1");
    await manager.uploadPart(uploadId, 1, Buffer.from("part1-"));
    await manager.uploadPart(uploadId, 2, Buffer.from("part2-"));
    await manager.uploadPart(uploadId, 3, Buffer.from("part3"));

    const assembled = await manager.complete(uploadId, [1, 2, 3]);
    expect(assembled.toString()).toBe("part1-part2-part3");
  });

  it("assembles parts regardless of upload order", async () => {
    const uploadId = manager.initiate("bucket", "key1");
    await manager.uploadPart(uploadId, 3, Buffer.from("C"));
    await manager.uploadPart(uploadId, 1, Buffer.from("A"));
    await manager.uploadPart(uploadId, 2, Buffer.from("B"));

    const assembled = await manager.complete(uploadId, [1, 2, 3]);
    expect(assembled.toString()).toBe("ABC");
  });

  it("cleans up staging dir after complete", async () => {
    const uploadId = manager.initiate("bucket", "key1");
    await manager.uploadPart(uploadId, 1, Buffer.from("data"));
    await manager.complete(uploadId, [1]);

    const stagingPath = join(tmpDir, uploadId);
    expect(existsSync(stagingPath)).toBe(false);
  });

  it("cleans up staging dir on abort", async () => {
    const uploadId = manager.initiate("bucket", "key1");
    await manager.uploadPart(uploadId, 1, Buffer.from("data"));
    manager.abort(uploadId);

    const stagingPath = join(tmpDir, uploadId);
    expect(existsSync(stagingPath)).toBe(false);
  });

  it("returns part ETag after upload", async () => {
    const uploadId = manager.initiate("bucket", "key1");
    const etag = await manager.uploadPart(uploadId, 1, Buffer.from("data"));
    expect(etag).toBeTruthy();
    expect(etag.startsWith('"')).toBe(true);
  });
});
