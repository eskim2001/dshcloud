import { z } from 'zod'
import { ImageRefSchema, InstanceSlugSchema, InstanceSpecSchema, INSTANCE_UID, INSTANCE_GID } from '@dsh-cloud/instance-spec'
import { DomainSchema } from '../../domain.js'
import { imageRepo } from '../../instance/image-catalog.js'
import { PORT_RANGE_START, PORT_RANGE_END } from '../../instance/port-allocator.js'

export const NODE_PROTOCOL_VERSION = 1
const key = z.string().regex(/^[a-f0-9]{32}(?:\.(?:prev|recovery))?$/u)
const machine = z.string().refine(value => value.startsWith('dsh-instance-') &&
  InstanceSlugSchema.safeParse(value.slice('dsh-instance-'.length)).success)
const size = z.number().int().positive().max(1_048_576)
const port = z.number().int().min(PORT_RANGE_START).max(PORT_RANGE_END)
const empty = z.tuple([])
const machineArgs = z.tuple([machine])
const keyArgs = z.tuple([key])

// Every operation has an explicit tuple schema; there is no arbitrary Docker method forwarding.
export const NodeRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('ensureImage'), args: z.tuple([ImageRefSchema]) }).strict(),
  z.object({ method: z.literal('imageExists'), args: z.tuple([ImageRefSchema]) }).strict(),
  z.object({ method: z.literal('openImagePull'), args: z.tuple([ImageRefSchema]) }).strict(),
  z.object({ method: z.literal('listImageTags'), args: empty }).strict(),
  z.object({ method: z.literal('create'), args: z.tuple([
    InstanceSpecSchema.strict(),
    z.object({ baseImage: ImageRefSchema, baseDomain: DomainSchema,
      gateToken: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/u),
      storageKey: z.string().regex(/^[a-f0-9]{32}$/u), hostPort: port }).strict(),
  ]) }).strict(),
  z.object({ method: z.literal('start'), args: machineArgs }).strict(),
  z.object({ method: z.literal('stop'), args: machineArgs }).strict(),
  z.object({ method: z.literal('remove'), args: machineArgs }).strict(),
  z.object({ method: z.literal('status'), args: machineArgs }).strict(),
  z.object({ method: z.literal('stats'), args: machineArgs }).strict(),
  z.object({ method: z.literal('logs'), args: z.tuple([machine, z.number().int().min(0).max(1000)]) }).strict(),
  z.object({ method: z.literal('probeHealthy'), args: z.tuple([machine, port]) }).strict(),
  z.object({ method: z.literal('listInstanceNames'), args: empty }).strict(),
  z.object({ method: z.literal('createStorage'), args: z.tuple([key, size]) }).strict(),
  z.object({ method: z.literal('ensureStorage'), args: keyArgs }).strict(),
  z.object({ method: z.literal('removeStorage'), args: keyArgs }).strict(),
  z.object({ method: z.literal('storageEnforced'), args: keyArgs }).strict(),
  z.object({ method: z.literal('storageUsageMb'), args: keyArgs }).strict(),
  z.object({ method: z.literal('storageUsageAll'), args: empty }).strict(),
  z.object({ method: z.literal('resizeStorage'), args: z.tuple([key, size]) }).strict(),
  z.object({ method: z.literal('chownStorage'), args: z.tuple([key, z.literal(INSTANCE_UID), z.literal(INSTANCE_GID)]) }).strict(),
  z.object({ method: z.literal('copyStorage'), args: z.tuple([key, key]) }).strict(),
  // 只接受活卷。快照卷（.prev / .recovery）不能写入模型凭据。正文是 UTF-8 YAML，上限跟节点 body 对齐。
  z.object({ method: z.literal('seedCredentialsFileIfAbsent'), args: z.tuple([
    z.string().regex(/^[a-f0-9]{32}$/u),
    z.string().min(1).max(8192),
  ]) }).strict(),
  z.object({ method: z.literal('heal'), args: empty }).strict(),
])
export type NodeRequest = z.infer<typeof NodeRequestSchema>

export function parseNodeRequest(raw: unknown, allowedImageRepo: string): NodeRequest {
  const request = NodeRequestSchema.parse(raw)
  const checkImage = (ref: string) => {
    if (imageRepo(ref) !== allowedImageRepo) throw new Error('Image repository is not permitted')
  }
  if (['ensureImage', 'imageExists', 'openImagePull'].includes(request.method)) {
    checkImage(request.args[0] as string)
  }
  if (request.method === 'create') {
    const [spec, context] = request.args
    checkImage(spec.image)
    if (spec.image !== context.baseImage) throw new Error('Image references do not match')
    if (Object.keys(spec.env).length > 64 || Object.values(spec.env).some(value => value.includes('\0') || value.length > 4096)) {
      throw new Error('Invalid environment')
    }
  }
  if (request.method === 'copyStorage') {
    const [from, to] = request.args
    const base = from.replace(/\.(?:prev|recovery)$/u, '')
    const allowed = (from === base && (to === `${base}.prev` || to === `${base}.recovery`)) ||
      (from === `${base}.prev` && to === base)
    if (!allowed) {
      throw new Error('Storage copy must stay within one instance')
    }
  }
  return request
}
