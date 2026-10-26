import { getFileApi } from '@@/apis/files'

export async function readNoteFile(path: string): Promise<{ content: string, rev: string }> {
  const response = await getFileApi(path)
  return { content: response.data, rev: String(response.headers.get('etag') ?? '').replace(/"/g, '') }
}
