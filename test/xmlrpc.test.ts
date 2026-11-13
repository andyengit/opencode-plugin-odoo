import { describe, expect, test } from "bun:test"
import { encodeRequest, encodeValue, parseResponse } from "../src/xmlrpc"

function response(body: string): string {
  return `<?xml version='1.0'?>\n<methodResponse><params><param>${body}</param></params></methodResponse>`
}

describe("encodeValue", () => {
  test("encodes the scalar types", () => {
    expect(encodeValue("hola & <mundo>")).toBe("<value><string>hola &amp; &lt;mundo&gt;</string></value>")
    expect(encodeValue(42)).toBe("<value><int>42</int></value>")
    expect(encodeValue(1.5)).toBe("<value><double>1.5</double></value>")
    expect(encodeValue(true)).toBe("<value><boolean>1</boolean></value>")
    expect(encodeValue(null)).toBe("<value><nil/></value>")
  })

  test("encodes arrays and structs", () => {
    expect(encodeValue([1, "a"])).toBe(
      "<value><array><data><value><int>1</int></value><value><string>a</string></value></data></array></value>",
    )
    expect(encodeValue({ limit: 5 })).toBe(
      "<value><struct><member><name>limit</name><value><int>5</int></value></member></struct></value>",
    )
  })
})

describe("encodeRequest", () => {
  test("wraps the method and params", () => {
    const xml = encodeRequest("authenticate", ["db", "admin", "secret", {}])
    expect(xml).toContain("<methodName>authenticate</methodName>")
    expect(xml).toContain("<value><string>db</string></value>")
  })
})

describe("parseResponse", () => {
  test("reads a scalar", () => {
    expect(parseResponse(response("<value><int>7</int></value>"))).toBe(7)
    expect(parseResponse(response("<value><string>ok</string></value>"))).toBe("ok")
    expect(parseResponse(response("<value><boolean>1</boolean></value>"))).toBe(true)
  })

  test("reads a struct like version", () => {
    const xml = response(
      "<value><struct><member><name>server_version</name><value><string>18.0</string></value></member><member><name>uid</name><value><int>2</int></value></member></struct></value>",
    )
    expect(parseResponse(xml)).toEqual({ server_version: "18.0", uid: 2 })
  })

  test("reads an array of structs like search_read", () => {
    const xml = response(
      "<value><array><data><value><struct><member><name>id</name><value><int>1</int></value></member></struct></value><value><struct><member><name>id</name><value><int>2</int></value></member></struct></value></data></array></value>",
    )
    expect(parseResponse(xml)).toEqual([{ id: 1 }, { id: 2 }])
  })

  test("reads nested arrays like a many2one", () => {
    const xml = response(
      "<value><array><data><value><array><data><value><int>238</int></value><value><string>Venezuela</string></value></data></array></value></data></array></value>",
    )
    expect(parseResponse(xml)).toEqual([[238, "Venezuela"]])
  })

  test("reads a row with relational fields like search_read", () => {
    const xml = response(
      [
        "<value><array><data><value><struct>",
        "<member><name>id</name><value><int>7</int></value></member>",
        "<member><name>name</name><value><string>ACME</string></value></member>",
        "<member><name>country_id</name><value><array><data><value><int>238</int></value><value><string>Venezuela</string></value></data></array></value></member>",
        "<member><name>child_ids</name><value><array><data><value><int>8</int></value><value><int>9</int></value></data></array></value></member>",
        "</struct></value></data></array></value>",
      ].join(""),
    )
    expect(parseResponse(xml)).toEqual([
      { id: 7, name: "ACME", country_id: [238, "Venezuela"], child_ids: [8, 9] },
    ])
  })

  test("reads name_search pairs", () => {
    const xml = response(
      [
        "<value><array><data>",
        "<value><array><data><value><int>1</int></value><value><string>Partner A</string></value></data></array></value>",
        "<value><array><data><value><int>2</int></value><value><string>Partner B</string></value></data></array></value>",
        "</data></array></value>",
      ].join(""),
    )
    expect(parseResponse(xml)).toEqual([
      [1, "Partner A"],
      [2, "Partner B"],
    ])
  })

  test("reads grouped rows with nested groups", () => {
    const xml = response(
      [
        "<value><array><data><value><struct>",
        "<member><name>country_id</name><value><array><data><value><int>238</int></value><value><string>Venezuela</string></value></data></array></value></member>",
        "<member><name>__count</name><value><int>3</int></value></member>",
        "</struct></value></data></array></value>",
      ].join(""),
    )
    expect(parseResponse(xml)).toEqual([{ country_id: [238, "Venezuela"], __count: 3 }])
  })

  test("throws the fault message", () => {
    const xml = `<?xml version='1.0'?><methodResponse><fault><value><struct><member><name>faultCode</name><value><int>1</int></value></member><member><name>faultString</name><value><string>Access Denied</string></value></member></struct></value></fault></methodResponse>`
    expect(() => parseResponse(xml)).toThrow("Access Denied")
  })
})
