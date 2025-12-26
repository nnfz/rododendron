import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function syncTauriConf(version) {
  const tauriConfPath = path.join(root, 'src-tauri', 'tauri.conf.json');
  const tauriConf = readJson(tauriConfPath);

  tauriConf.version = version;
  writeJson(tauriConfPath, tauriConf);
}

function syncCargoToml(version) {
  const cargoPath = path.join(root, 'src-tauri', 'Cargo.toml');
  const cargo = fs.readFileSync(cargoPath, 'utf8');

  const next = cargo.replace(
    /((?:^|\n)\[package\][\s\S]*?\nversion\s*=\s*")([^"]+)(")/m,
    (_m, p1, _old, p3) => `${p1}${version}${p3}`
  );

  if (next === cargo) {
    throw new Error('Failed to update src-tauri/Cargo.toml: could not find [package].version');
  }

  fs.writeFileSync(cargoPath, next, 'utf8');
}

function main() {
  const pkgPath = path.join(root, 'package.json');
  const pkg = readJson(pkgPath);
  const version = pkg.version;

  if (!version || typeof version !== 'string') {
    throw new Error('package.json version is missing or invalid');
  }

  syncTauriConf(version);
  syncCargoToml(version);

  console.log(`Synced version ${version} to src-tauri/tauri.conf.json and src-tauri/Cargo.toml`);
}

main();
