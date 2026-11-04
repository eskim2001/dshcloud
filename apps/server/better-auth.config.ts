// 仅供 `@better-auth/cli generate` 读取 schema 用，不参与运行时。
// 校验方式：生成结果与本包 src/db/schema.ts 的 auth 部分必须一致。
import { createAuth } from './src/auth.js'
import { createDb } from './src/db/client.js'
import type { Env } from './src/env.js'

const env: Env = {
  DATABASE_URL: 'postgres://localhost:5432/placeholder',
  BASE_DOMAIN: 'app.example.com',
  CONSOLE_DOMAIN: 'console.app.example.com',
  PLATFORM_SECRET: 'x'.repeat(32),
  BETTER_AUTH_SECRET: 'y'.repeat(32),
  PORT: 3000,
  CONTROL_PLANE_LISTEN_HOST: '0.0.0.0',
  PLATFORM_MAX_CPUS: 2,
  PLATFORM_MAX_MEMORY_MB: 2048,
  PLATFORM_MAX_PIDS: 512,
  PLATFORM_MAX_DISK_MB: 10_240,
  PLATFORM_MAX_RUNNING: 3,
  PLATFORM_IDLE_CULL_MINUTES: 45,
  PUBLIC_SCHEME: 'https',
  WEB_DIST_DIR: '',
  EXTRA_TRUSTED_ORIGINS: '',
  TRAEFIK_ENTRYPOINT: 'websecure',
  TRAEFIK_CERT_RESOLVER: '',
  MAX_INSTANCES_PER_USER: 3,
  HOST_STORAGE_ROOT: '/var/lib/dsh',
  INSTANCE_UPSTREAM_HOST: '127.0.0.1',
  INSTANCE_IMAGE_REPO: 'ghcr.io/eskim2001/dsh-instance',
  INSTANCE_IMAGE_REGISTRY_USER: '',
  INSTANCE_IMAGE_REGISTRY_TOKEN: '',
  SETUP_TOKEN: '',
  SELF_CONTAINER: '',
  DEMO_EMAIL: '',
  DEMO_PASSWORD: '',
}

const { db } = createDb(env.DATABASE_URL)
export const auth = createAuth(env, db)
