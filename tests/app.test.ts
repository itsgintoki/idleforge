import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

const app = createApp({ signup: async () => { throw new Error("Not used by these tests"); } });

describe("GET /health", () => {
    it("returns an ok status", async () => {
        const response = await request(app).get("/health");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: "ok" });
    });
});

describe("GET /", () => {
    it("returns the name and version", async () => {
        const response = await request(app).get("/");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ name: "IdleForge", version: "0.1.0" });
    });
});
