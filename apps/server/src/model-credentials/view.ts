/** 管理台看得到的全部。没有明文，也没有密文。 */
export interface ModelCredentialPublic {
  configured: boolean
  providerRefs: string[]
  updatedAt: Date | null
}

export function projectModelCredentials(
  rows: Array<{ providerRef: string; updatedAt: Date }>,
): ModelCredentialPublic {
  const providerRefs = rows.map((row) => row.providerRef).sort()
  let updatedAt: Date | null = null
  for (const row of rows) {
    if (updatedAt === null || row.updatedAt > updatedAt) updatedAt = row.updatedAt
  }
  return { configured: providerRefs.length > 0, providerRefs, updatedAt }
}
