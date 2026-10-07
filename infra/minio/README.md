# MinIO Local

Bucket `astella-workspaces` is auto-created by `minio-init` in the local development stack (`make up` / `make storage`). Alpha verification also defines its own MinIO services in `docker-compose.alpha.yml`.

Production (`docker-compose.yml` + `docker-compose.deploy.yml`) uses private remote S3 and contains no MinIO service or data volume.

Console: http://localhost:9001 (user `astella` / pw `astella_dev_secret`)
API: http://localhost:9000
