#!/usr/bin/env node
import { cpSync, existsSync, rmSync } from "node:fs";
import { parse, resolve } from "node:path";

const [sourceArg, destinationArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg) {
  throw new Error("usage: copy-directory <source> <destination>");
}

const source = resolve(sourceArg);
const destination = resolve(destinationArg);
if (!existsSync(source)) throw new Error(`asset directory does not exist: ${source}`);
if (source === destination || destination === parse(destination).root) {
  throw new Error(`refusing unsafe asset destination: ${destination}`);
}
rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true, force: true });
