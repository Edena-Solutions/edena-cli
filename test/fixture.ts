import type { Document } from "../src/reference.js";

/** A small reference with the shapes the CLI reads: a list, a record, a write, a file. */
export const DOCUMENT: Document = {
    info: { title: "Edena API", version: "1" },
    tags: [
        { name: "Clients", "x-displayName": "Students", description: "Students: their data, units and payers." },
        { name: "Invoices", "x-displayName": "Invoices", description: "Invoices and their lines." },
    ],
    paths: {
        "/clients": {
            get: {
                operationId: "clients_list",
                summary: "Lists the students, with search and filters, in pages.",
                tags: ["Clients"],
                "x-cli": "students list",
                parameters: [
                    { name: "status", in: "query", schema: { type: "string", enum: ["active", "inactive"] } },
                    { name: "page", in: "query", schema: { type: "number" } },
                ],
                responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/ClientPage" } } } } },
            },
            post: {
                operationId: "clients_create",
                summary: "Creates a student.",
                tags: ["Clients"],
                "x-cli": "students create",
                parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" } }],
                requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateClientDto" } } } },
                responses: { "201": { content: { "application/json": { schema: { $ref: "#/components/schemas/Client" } } } } },
            },
        },
        "/clients/{id}": {
            get: {
                operationId: "clients_getById",
                summary: "Returns one student.",
                tags: ["Clients"],
                "x-cli": "students get",
                parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
                responses: {
                    "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Client" } } } },
                    "404": { description: "Not found." },
                },
            },
        },
        "/invoices/{id}/pdf": {
            get: {
                operationId: "invoices_pdf",
                summary: "Downloads an invoice as a PDF.",
                tags: ["Invoices"],
                "x-cli": "invoices pdf",
                parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
                responses: { "200": { content: { "application/pdf": { schema: { type: "string", format: "binary" } } } } },
            },
        },
    },
    components: {
        schemas: {
            Client: {
                type: "object",
                required: ["id", "name"],
                properties: { id: { type: "string", format: "uuid" }, name: { type: "string" }, age: { type: "integer" } },
            },
            ClientPage: {
                type: "object",
                properties: { data: { type: "array", items: { $ref: "#/components/schemas/Client" } }, meta: { type: "object" } },
            },
            CreateClientDto: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string", maxLength: 120 }, age: { type: "integer" } },
            },
            ErrorResponse: { type: "object", properties: { key: { type: "string" } } },
        },
    },
};
