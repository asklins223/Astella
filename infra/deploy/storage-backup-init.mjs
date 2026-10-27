import { S3Client, HeadBucketCommand, CreateBucketCommand, DeleteBucketPolicyCommand } from '@aws-sdk/client-s3';
import { mkdir, chown, chmod } from 'node:fs/promises';

const bucket = process.env.S3_BUCKET || 'astella-backup';
const client = new S3Client({ endpoint: 'http://backup-minio:9000', region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: process.env.MINIO_ROOT_USER, secretAccessKey: process.env.MINIO_ROOT_PASSWORD },
  maxAttempts: 3 });
try {
  try { await client.send(new HeadBucketCommand({ Bucket: bucket })); }
  catch (error) {
    if (error.$metadata?.httpStatusCode !== 404) throw error;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  // MinIO buckets are private by default; also remove any old anonymous policy on rerun.
  await client.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
  await mkdir('/queue', { recursive: true });
  await chown('/queue', 1000, 1000); await chmod('/queue', 0o700);
  console.log('Private standby bucket and queue are ready.');
} finally { client.destroy(); }
