import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PlaceIndex } from "./place";

let cached: PlaceIndex | null = null;
/** The committed shared-data snapshot (place-index.json). */
export function loadPlaceIndex(): PlaceIndex {
  return (cached ??= JSON.parse(readFileSync(resolve(__dirname, "..", "place-index.json"), "utf8")) as PlaceIndex);
}
