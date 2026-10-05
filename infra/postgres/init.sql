-- Cryptographically secure UUIDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- Trigram similarity for fuzzy quote matching in Evidence alignment
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Vector embeddings. 0052_supervisor_agent_v1_schema 起十余份迁移要
-- `CREATE EXTENSION IF NOT EXISTS vector`，但迁移跑在 ailearn_migrator 上，
-- 建扩展是超级用户权限 —— 所以必须在这里（新库）或 apply-roles/roles.sql
-- （既有 volume）预先建好。漏了它，fresh 库会停在 0052 报
-- `permission denied to create extension "vector"`。
-- 镜像须带 pgvector。
CREATE EXTENSION IF NOT EXISTS vector;