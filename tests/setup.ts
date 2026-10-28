import { mock } from "bun:test";
import { mockVscode } from "./mocks/vscode.js";

mock.module("vscode", () => mockVscode);
