// server-only
import path from "path";

const CONVERTER_URL = process.env.CONVERTER_URL ?? "http://converter:8000";

export async function convertToMarkdown(
  fileName: string,
  data: Uint8Array
): Promise<string> {
  const form = new FormData();
  // Copy into a fresh ArrayBuffer-backed view so the type is Uint8Array<ArrayBuffer>
  // (a Uint8Array<ArrayBufferLike> is not assignable to BlobPart under strict TS).
  form.append("file", new Blob([new Uint8Array(data)]), fileName);

  const res = await fetch(`${CONVERTER_URL}/convert`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `converter responded ${res.status}: ${body}`
    );
  }

  const json = (await res.json()) as { filename: string; markdown: string };
  return json.markdown;
}

export const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".csv",
  ".json",
  ".xml",
  ".log",
]);

export function isAlreadyText(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}
