export function errorXml(code: string, message: string, resource: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>${code}</Code>
  <Message>${message}</Message>
  <Resource>${resource}</Resource>
  <RequestId>0</RequestId>
</Error>`;
}

export function emptyListXml(bucket: string, prefix: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${bucket}</Name>
  <Prefix>${prefix}</Prefix>
  <KeyCount>0</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`;
}

export function initiateMultipartXml(bucket: string, key: string, uploadId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${bucket}</Bucket>
  <Key>${key}</Key>
  <UploadId>${uploadId}</UploadId>
</InitiateMultipartUploadResult>`;
}

export function completeMultipartXml(bucket: string, key: string, etag: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${bucket}</Bucket>
  <Key>${key}</Key>
  <ETag>${etag}</ETag>
</CompleteMultipartUploadResult>`;
}
