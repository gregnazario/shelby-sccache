import { Hono } from "hono";
import type { S3Handlers } from "./s3-handlers";
import type { MultipartManager } from "./s3-multipart";
import { emptyListXml, errorXml, initiateMultipartXml, completeMultipartXml } from "./s3-xml";
import { createHash } from "crypto";
import { logger } from "../logger";

export function createS3Router(handlers: S3Handlers, multipart: MultipartManager): Hono {
  const app = new Hono();

  // GET /:bucket — ListObjectsV2 or GetObject
  app.get("/:bucket/*", async (c) => {
    const key = c.req.param("*") ?? "";
    const bucket = c.req.param("bucket");

    if (c.req.query("list-type") || !key) {
      const prefix = c.req.query("prefix") ?? "";
      return c.body(emptyListXml(bucket, prefix), 200, { "Content-Type": "application/xml" });
    }

    const result = await handlers.getObject(key);
    if (result.status === 404) {
      return c.body(errorXml("NoSuchKey", "The specified key does not exist.", `/${bucket}/${key}`), 404, {
        "Content-Type": "application/xml",
      });
    }
    return c.body(new Uint8Array(result.body!), 200, { "Content-Type": "application/octet-stream", ...result.headers });
  });

  // PUT /:bucket/:key+ — PutObject OR UploadPart
  app.put("/:bucket/*", async (c) => {
    const key = c.req.param("*") ?? "";

    const uploadId = c.req.query("uploadId");
    const partNumber = c.req.query("partNumber");
    if (uploadId && partNumber) {
      const body = Buffer.from(await c.req.arrayBuffer());
      const etag = await multipart.uploadPart(uploadId, parseInt(partNumber), body);
      return c.body(null, 200, { ETag: etag });
    }

    const body = Buffer.from(await c.req.arrayBuffer());
    const result = await handlers.putObject(key, body);
    return c.body(null, 200, { ETag: result.headers?.ETag ?? "" });
  });

  // HEAD /:bucket/:key+
  app.on("HEAD", "/:bucket/*", async (c) => {
    const key = c.req.param("*") ?? "";
    const result = await handlers.headObject(key);
    return c.body(null, result.status as 200);
  });

  // DELETE /:bucket/:key+ — DeleteObject OR AbortMultipartUpload
  app.delete("/:bucket/*", (c) => {
    const uploadId = c.req.query("uploadId");
    if (uploadId) {
      multipart.abort(uploadId);
    }
    return c.body(null, 204);
  });

  // POST /:bucket/:key+ — CreateMultipartUpload OR CompleteMultipartUpload
  app.post("/:bucket/*", async (c) => {
    const key = c.req.param("*") ?? "";
    const bucket = c.req.param("bucket");

    if (c.req.query("uploads") !== undefined) {
      const uploadId = multipart.initiate(bucket, key);
      logger.debug("Initiated multipart upload", { key, uploadId });
      return c.body(initiateMultipartXml(bucket, key, uploadId), 200, { "Content-Type": "application/xml" });
    }

    const uploadId = c.req.query("uploadId");
    if (uploadId) {
      try {
        const xmlBody = await c.req.text();
        const partNumbers = [...xmlBody.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => parseInt(m[1]));
        const assembled = await multipart.complete(uploadId, partNumbers);
        const result = await handlers.putObject(key, assembled);
        const etag = result.headers?.ETag ?? `"${createHash("md5").update(assembled).digest("hex")}"`;
        return c.body(completeMultipartXml(bucket, key, etag), 200, { "Content-Type": "application/xml" });
      } catch (err) {
        logger.error("CompleteMultipartUpload failed", { uploadId, error: String(err) });
        return c.body(errorXml("InternalError", String(err), `/${bucket}/${key}`), 500, {
          "Content-Type": "application/xml",
        });
      }
    }

    return c.body(null, 400);
  });

  return app;
}
