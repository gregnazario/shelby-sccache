import { describe, it, expect } from "bun:test";
import { errorXml, emptyListXml, initiateMultipartXml, completeMultipartXml } from "../../src/proxy/s3-xml";

describe("s3-xml", () => {
  it("generates error XML", () => {
    const xml = errorXml("NoSuchKey", "The specified key does not exist.", "/bucket/key");
    expect(xml).toContain("<Code>NoSuchKey</Code>");
    expect(xml).toContain("<Message>The specified key does not exist.</Message>");
    expect(xml).toContain("<Resource>/bucket/key</Resource>");
  });

  it("generates empty list XML", () => {
    const xml = emptyListXml("my-bucket", "sccache/v1/");
    expect(xml).toContain("<Name>my-bucket</Name>");
    expect(xml).toContain("<Prefix>sccache/v1/</Prefix>");
    expect(xml).toContain("<KeyCount>0</KeyCount>");
  });

  it("generates initiate multipart upload XML", () => {
    const xml = initiateMultipartXml("my-bucket", "key123", "upload-id-abc");
    expect(xml).toContain("<Bucket>my-bucket</Bucket>");
    expect(xml).toContain("<Key>key123</Key>");
    expect(xml).toContain("<UploadId>upload-id-abc</UploadId>");
  });

  it("generates complete multipart upload XML", () => {
    const xml = completeMultipartXml("my-bucket", "key123", "\"etag-xyz\"");
    expect(xml).toContain("<Bucket>my-bucket</Bucket>");
    expect(xml).toContain("<Key>key123</Key>");
    expect(xml).toContain("<ETag>\"etag-xyz\"</ETag>");
  });
});
