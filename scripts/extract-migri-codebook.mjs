import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const inputArgument = process.argv[2];
const outputPath = resolve(
  process.cwd(),
  process.argv[3] ?? "config/migri-codebook.en.json",
);

if (!inputArgument) {
  throw new Error(
    "Pass the downloaded statistics.migri.fi JavaScript bundle as the first argument.",
  );
}

const inputPath = resolve(process.cwd(), inputArgument);
const input = readFileSync(inputPath);
const source = input[0] === 0x1f && input[1] === 0x8b
  ? gunzipSync(input).toString("utf8")
  : input.toString("utf8");

function decodeSingleQuotedString(value) {
  let decoded = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }

    const escape = value[index + 1];
    index += 1;
    if (escape === "n") decoded += "\n";
    else if (escape === "r") decoded += "\r";
    else if (escape === "t") decoded += "\t";
    else if (escape === "b") decoded += "\b";
    else if (escape === "f") decoded += "\f";
    else if (escape === "v") decoded += "\v";
    else if (escape === "0") decoded += "\0";
    else if (escape === "x") {
      decoded += String.fromCharCode(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
    } else if (escape === "u") {
      decoded += String.fromCharCode(Number.parseInt(value.slice(index + 1, index + 5), 16));
      index += 4;
    } else {
      decoded += escape;
    }
  }

  return decoded;
}

const embeddedJsonPattern = /t\.exports=JSON\.parse\('((?:\\.|[^'])*)'\)/g;
let codebook;
let match;

while ((match = embeddedJsonPattern.exec(source))) {
  const candidate = JSON.parse(decodeSingleQuotedString(match[1]));
  if (candidate?.caseGroups) {
    codebook = candidate;
    break;
  }
}

if (!codebook) {
  throw new Error("Could not find Migri's embedded case-group codebook in the bundle.");
}

const groupCodes = [
  "ASIARYHMA_ID",
  "ASIA_TYYPPI_ID",
  "KASITTELYPERUSTE_TASO_ID",
  "KASITTELYPERUSTE_ID",
];
const groups = {};

for (const groupCode of groupCodes) {
  const sourceGroup = codebook.caseGroups[groupCode] ?? {};
  groups[groupCode] = Object.fromEntries(
    Object.entries(sourceGroup)
      .filter(([, item]) => typeof item?.en === "string" && item.en.trim())
      .map(([id, item]) => [id, item.en.replaceAll("\u00a0", " ").trim()]),
  );
}

const countries = Object.fromEntries(
  Object.entries(codebook.countries ?? {})
    .filter(([, item]) => typeof item?.en === "string" && item.en.trim())
    .map(([id, item]) => [id, item.en.replaceAll("\u00a0", " ").trim()]),
);

const output = {
  source: "https://statistics.migri.fi/",
  bundleFile: basename(inputPath),
  language: "en",
  groups,
  countries,
};

writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(
  `Extracted ${Object.values(groups).reduce((total, group) => total + Object.keys(group).length, 0)} taxonomy labels and ${Object.keys(countries).length} citizenship labels to ${outputPath}`,
);
