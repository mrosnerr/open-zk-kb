#!/usr/bin/env bun

/**
 * Migrate 12-digit note IDs (YYYYMMDDHHmm) to 16-digit (YYYYMMDDHHmmss00).
 * Handles: filenames, frontmatter id, related_notes, wikilinks.
 * After running, rebuild the DB with: bun scripts/rebuild-db.ts <vault-path>
 */

import * as fs from 'fs';
import * as path from 'path';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const vaultArg = args.find(arg => !arg.startsWith('-'));
const vaultPath = (vaultArg || '~/.local/share/open-zk-kb').replace(/^~/, process.env.HOME || '~');

if (!fs.existsSync(vaultPath)) {
  console.error(`Vault not found: ${vaultPath}`);
  process.exit(1);
}

if (DRY_RUN) console.log('=== DRY RUN (no changes will be made) ===\n');

// 1. Scan all .md files and collect IDs (sorted for deterministic ordering)
const files = fs.readdirSync(vaultPath).filter(f => f.endsWith('.md')).sort();
const idMap = new Map<string, string>(); // old -> new

// Track collisions: group 12-digit IDs that appear in multiple files
const idToFiles = new Map<string, string[]>();

for (const file of files) {
  const content = fs.readFileSync(path.join(vaultPath, file), 'utf-8');
  // Restrict ID detection to YAML frontmatter at the top of the file
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*/);
  if (!frontmatterMatch) continue;
  const frontmatter = frontmatterMatch[1];
  const idMatch = frontmatter.match(/^id:\s*(\d+)\s*$/m);
  if (!idMatch) continue;
  
  const id = idMatch[1];
  const existing = idToFiles.get(id) || [];
  existing.push(file);
  idToFiles.set(id, existing);
}

// 2. Build migration map
for (const [id, fileList] of idToFiles) {
  if (id.length === 16) continue; // already 16-digit, skip
  
  if (id.length === 12) {
    // YYYYMMDDHHmm -> YYYYMMDDHHmm0000 (ss=00, counter=00)
    if (fileList.length === 1) {
      idMap.set(id, `${id}0000`);
    } else {
      // Collision: sort for deterministic assignment, then assign incrementing counter
      const sortedFileList = [...fileList].sort();
      if (sortedFileList.length > 100) {
        console.error(`Too many collisions for ID ${id} (${sortedFileList.length} notes). Max 100.`);
        process.exit(1);
      }
      for (let i = 0; i < sortedFileList.length; i++) {
        const counter = String(i).padStart(2, '0');
        idMap.set(`${id}:${sortedFileList[i]}`, `${id}00${counter}`);
      }
      // Also set the base mapping for wikilink/related_notes references
      // These point to the first note (best effort)
      idMap.set(id, `${id}0000`);
    }
  } else {
    console.warn(`Unexpected ID length (${id.length}): ${id} — skipping`);
  }
}

if (idMap.size === 0) {
  console.log('No 12-digit IDs found. Nothing to migrate.');
  process.exit(0);
}

console.log('Migration map:');
for (const [old, newId] of idMap) {
  if (!old.includes(':')) {
    console.log(`  ${old} -> ${newId}`);
  }
}

// Check collision entries
for (const [key, newId] of idMap) {
  if (key.includes(':')) {
    const [id, file] = key.split(':');
    console.log(`  ${id} (${file}) -> ${newId}`);
  }
}

console.log('');

// 3. Process each file
let filesUpdated = 0;
let filesRenamed = 0;

for (const file of files) {
  const filePath = path.join(vaultPath, file);
  let content = fs.readFileSync(filePath, 'utf-8');
  let changed = false;
  
  // Get this file's ID from YAML frontmatter
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*/);
  if (!fmMatch) continue;
  const idMatch = fmMatch[1].match(/^id:\s*(\d+)\s*$/m);
  if (!idMatch) continue;
  const currentId = idMatch[1];
  
  // Determine new ID for this file
  let newId: string | undefined;
  if (currentId.length === 12) {
    // Check if this is a collision ID
    const collisionKey = `${currentId}:${file}`;
    newId = idMap.get(collisionKey) || idMap.get(currentId);
  }
  
  // Update frontmatter id
  if (newId && currentId.length === 12) {
    content = content.replace(/^(id:\s*)\d+\s*$/m, `$1${newId}`);
    changed = true;
  }
  
  // Update related_notes references
  for (const [oldRef, newRef] of idMap) {
    if (oldRef.includes(':')) continue; // skip collision-qualified keys
    // related_notes entries
    const relPattern = new RegExp(`(- )${oldRef}(\\s)`, 'g');
    const relReplaced = content.replace(relPattern, `$1${newRef}$2`);
    // Also handle end-of-line
    const relPattern2 = new RegExp(`(- )${oldRef}$`, 'gm');
    const relReplaced2 = relReplaced.replace(relPattern2, `$1${newRef}`);
    if (relReplaced2 !== content) {
      content = relReplaced2;
      changed = true;
    }
    
    // Wikilinks: [[oldId]], [[oldId|display]], [[oldId-slug]], [[oldId-slug|display]], [[oldId-slug#heading|display]]
    const wikiPattern = new RegExp(`\\[\\[${oldRef}(-[^#|\\]]*)?(#(?:[^|\\]]*))?(\\|[^\\]]*)?\\]\\]`, 'g');
    const wikiReplaced = content.replace(wikiPattern, (_match, slug, heading, display) => {
      return `[[${newRef}${slug || ''}${heading || ''}${display || ''}]]`;
    });
    if (wikiReplaced !== content) {
      content = wikiReplaced;
      changed = true;
    }
  }
  
  if (changed) {
    filesUpdated++;
    if (DRY_RUN) {
      console.log(`Would update: ${file}`);
    } else {
      fs.writeFileSync(filePath, content, 'utf-8');
      console.log(`Updated: ${file}`);
    }
  }
  
  // Rename file if ID changed
  if (newId && currentId.length === 12) {
    const newFile = file.replace(currentId, newId);
    if (newFile !== file) {
      filesRenamed++;
      if (DRY_RUN) {
        console.log(`Would rename: ${file} -> ${newFile}`);
      } else {
        fs.renameSync(filePath, path.join(vaultPath, newFile));
        console.log(`Renamed: ${file} -> ${newFile}`);
      }
    }
  }
}

console.log(`\nDone: ${filesUpdated} files updated, ${filesRenamed} files renamed.`);
if (!DRY_RUN) {
  console.log('\nNow rebuild the DB:');
  console.log(`  bun scripts/rebuild-db.ts ${vaultPath}`);
}
