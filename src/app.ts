import express from "express";

export const app = express();

app.use(express.json());

app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

app.get("/", (req, res) => {
    res.json({
        "name": "IdleForge",
        "version": "0.1.0"
    })
})