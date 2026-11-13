/** A minimal XML-RPC client: Odoo only needs strings, numbers, booleans, arrays and structs. */

export type XmlValue = string | number | boolean | null | XmlValue[] | { [key: string]: XmlValue }

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function unescapeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (all, name: string) => ENTITIES[name] ?? all)
}

export function encodeValue(value: unknown): string {
  if (value === null || value === undefined) return "<value><nil/></value>"
  if (typeof value === "boolean") return `<value><boolean>${value ? 1 : 0}</boolean></value>`
  if (typeof value === "number") {
    return Number.isInteger(value) ? `<value><int>${value}</int></value>` : `<value><double>${value}</double></value>`
  }
  if (typeof value === "string") return `<value><string>${escapeXml(value)}</string></value>`
  if (Array.isArray(value)) return `<value><array><data>${value.map(encodeValue).join("")}</data></array></value>`
  if (typeof value === "object") {
    const members = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `<member><name>${escapeXml(key)}</name>${encodeValue(item)}</member>`)
      .join("")
    return `<value><struct>${members}</struct></value>`
  }
  return `<value><string>${escapeXml(String(value))}</string></value>`
}

export function encodeRequest(method: string, params: unknown[]): string {
  const body = params.map((param) => `<param>${encodeValue(param)}</param>`).join("")
  return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(method)}</methodName><params>${body}</params></methodCall>`
}

function skipSpace(xml: string, index: number): number {
  let i = index
  while (i < xml.length && /\s/.test(xml[i] ?? "")) i++
  return i
}

function expectTag(xml: string, index: number, tag: string): number {
  const open = `<${tag}>`
  if (!xml.startsWith(open, index)) throw new Error(`Expected ${open} at ${index}`)
  return index + open.length
}

function readBlock(xml: string, index: number, tag: string): { text: string; end: number } {
  const start = expectTag(xml, index, tag)
  const close = `</${tag}>`
  const end = xml.indexOf(close, start)
  if (end === -1) throw new Error(`Missing ${close}`)
  return { text: xml.slice(start, end), end: end + close.length }
}

/** Consumes a `</value>` that follows composite values. */
function closeValue(xml: string, index: number): number {
  const i = skipSpace(xml, index)
  return xml.startsWith("</value>", i) ? i + "</value>".length : i
}

/** Parses one `<value>` starting at or after `from`. */
export function parseValueAt(xml: string, from: number): { value: XmlValue; end: number } {
  let i = skipSpace(xml, from)
  const open = xml.indexOf("<value>", i)
  if (open === -1) throw new Error(`Expected <value> at ${i}`)
  i = open + "<value>".length
  i = skipSpace(xml, i)

  if (xml.startsWith("<nil/>", i)) return { value: null, end: i + 6 }
  if (xml.startsWith("<boolean>", i)) {
    const block = readBlock(xml, i, "boolean")
    const text = block.text.trim().toLowerCase()
    return { value: text === "1" || text === "true", end: block.end }
  }
  if (xml.startsWith("<int>", i) || xml.startsWith("<i4>", i)) {
    const tag = xml.startsWith("<int>", i) ? "int" : "i4"
    const block = readBlock(xml, i, tag)
    return { value: Number(block.text.trim()), end: block.end }
  }
  if (xml.startsWith("<double>", i)) {
    const block = readBlock(xml, i, "double")
    return { value: Number(block.text.trim()), end: block.end }
  }
  if (xml.startsWith("<string>", i)) {
    const block = readBlock(xml, i, "string")
    return { value: unescapeXml(block.text), end: block.end }
  }
  if (xml.startsWith("<dateTime.iso8601>", i)) {
    const block = readBlock(xml, i, "dateTime.iso8601")
    return { value: block.text.trim(), end: block.end }
  }
  if (xml.startsWith("<base64>", i)) {
    const block = readBlock(xml, i, "base64")
    return { value: block.text.trim(), end: block.end }
  }
  if (xml.startsWith("<array>", i)) {
    let j = skipSpace(xml, expectTag(xml, i, "array"))
    j = skipSpace(xml, expectTag(xml, j, "data"))
    const values: XmlValue[] = []
    while (true) {
      j = skipSpace(xml, j)
      if (xml.startsWith("</data>", j)) {
        return { value: values, end: closeValue(xml, j + "</data>".length) }
      }
      const parsed = parseValueAt(xml, j)
      values.push(parsed.value)
      j = parsed.end
    }
  }
  if (xml.startsWith("<struct>", i)) {
    let j = skipSpace(xml, expectTag(xml, i, "struct"))
    const record: Record<string, XmlValue> = {}
    while (true) {
      j = skipSpace(xml, j)
      if (xml.startsWith("</struct>", j)) {
        return { value: record, end: closeValue(xml, j + "</struct>".length) }
      }
      j = skipSpace(xml, expectTag(xml, j, "member"))
      const name = readBlock(xml, j, "name")
      const value = parseValueAt(xml, name.end)
      record[unescapeXml(name.text)] = value.value
      const close = xml.indexOf("</member>", value.end)
      j = close === -1 ? value.end : close + "</member>".length
    }
  }

  const close = xml.indexOf("</value>", i)
  if (close === -1) return { value: unescapeXml(xml.slice(i).trim()), end: xml.length }
  return { value: unescapeXml(xml.slice(i, close).trim()), end: close + "</value>".length }
}

/** Parses the `<methodResponse>` body, throwing the server's fault message. */
export function parseResponse(xml: string): XmlValue {
  if (xml.includes("<fault>")) {
    const value = parseValueAt(xml, xml.indexOf("<fault>")).value
    const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}
    const message = typeof record.faultString === "string" ? record.faultString : "XML-RPC fault"
    throw new Error(message)
  }
  return parseValueAt(xml, Math.max(0, xml.indexOf("<params>"))).value
}

export async function call(url: string, method: string, params: unknown[], timeoutMs = 30000): Promise<XmlValue> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "text/xml", accept: "text/xml" },
    body: encodeRequest(method, params),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`XML-RPC ${method} failed (${response.status}): ${text.slice(0, 300)}`)
  return parseResponse(text)
}
